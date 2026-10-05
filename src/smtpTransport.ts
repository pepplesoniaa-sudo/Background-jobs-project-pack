import { Readable } from "node:stream";
import nodemailer, { type Transporter } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import { jobRefFor, messageIdForRef, senderDomainOf } from "./messageId.js";
import type { MailMessage, MailTransport, SendOptions, TransportOutcome } from "./transport.js";

export interface SmtpSettings {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
}

// The nodemailer options for a real server. Port 465 is TLS from the start. Any other port must
// upgrade with STARTTLS before the password is sent, otherwise the send fails instead of leaking it.
// The three timeouts are all SEND_TIMEOUT_MS, so a hung server cannot hold a worker slot much past it
// (nodemailer's own default socket timeout is 10 minutes). They limit silence, not total time.
export function smtpOptions(settings: SmtpSettings, timeoutMs: number): SMTPTransport.Options {
  const secure = settings.port === 465;
  return {
    host: settings.host,
    port: settings.port,
    secure,
    requireTLS: !secure,
    auth: { user: settings.user, pass: settings.password },
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
  };
}

const AUTH_REFUSALS = [530, 534, 535];
const LOGIN_FAILED = "mail account login failed";

interface SmtpError {
  code?: string;
  command?: string;
  responseCode?: number;
}

// Sorts an SMTP failure into "we know it was not sent" or "we do not know".
// Unknown is the safe answer: under flag_for_human it becomes a human task, never a duplicate.
// SMTP is not HTTP: 4xx is a TEMPORARY refusal (try again later) and 5xx is PERMANENT.
//
// `bodyPulled` says whether any of the message was ever handed to the connection. It is the only
// reliable evidence of the phase. nodemailer's own error.command is NOT: a timeout or a dropped
// connection AFTER the whole message was sent is still reported as command "CONN" (found by a test).
//
// Nothing here may put an address into its result: error text can carry one, so only codes and
// fixed summaries are used.
export function classifySmtpError(err: unknown, bodyPulled: boolean): TransportOutcome {
  const e = (err ?? {}) as SmtpError;

  // 1. The server answered with a definite code, so it did not accept the message.
  if (typeof e.responseCode === "number" && e.responseCode >= 400 && e.responseCode < 600) {
    // 4xx (421, 450, 451, 452, 454, ...): temporary. This includes a temporary login refusal (454).
    if (e.responseCode < 500) return { outcome: "refused", status: e.responseCode, retryable: true };
    // 5xx: permanent. A wrong password is permanent too: fix the setting first, then use manual retry.
    if (AUTH_REFUSALS.includes(e.responseCode) || String(e.command ?? "").startsWith("AUTH")) {
      return { outcome: "refused", status: e.responseCode, retryable: false, summary: LOGIN_FAILED };
    }
    return { outcome: "refused", status: e.responseCode, retryable: false };
  }

  // 2. No reply, but the mail library itself says what is wrong, and it says so before anything is
  //    sent. These are permanent: trying again cannot change them. (Statuses here are only labels.)
  if (e.code === "EAUTH") return { outcome: "refused", status: 535, retryable: false, summary: LOGIN_FAILED };
  if (e.code === "EENVELOPE") {
    return { outcome: "refused", status: 550, retryable: false, summary: "recipient address rejected" };
  }
  if (e.code === "EMESSAGE") {
    return { outcome: "refused", status: 552, retryable: false, summary: "message rejected before sending" };
  }

  // 3. Any other error with no reply (timeout, dropped connection, DNS, refused connection). If no
  //    part of the message was ever pulled for sending, nothing can have been delivered. Otherwise
  //    we cannot know. The reason is the error code only, never the error text.
  if (!bodyPulled) return { outcome: "refused", status: 421, retryable: true };
  return { outcome: "unknown", reason: `smtp ${e.code ?? "error"}` };
}

// SMTP has no idempotency key, so a send cannot be repeated safely if its outcome is unknown.
// So that a person can still match an email to its job, every email carries a short one-way label of
// the job id (the job ref) in an X-Job-Ref header and in its Message-ID. The raw job id appears in no
// header (owner's ruling), and the Message-ID uses the domain of the configured sender.
export class SmtpTransport implements MailTransport {
  private readonly transporter: Transporter<SMTPTransport.SentMessageInfo>;
  private readonly domain: string;

  constructor(
    options: SMTPTransport.Options,
    private readonly from: string,
  ) {
    // Fails at startup, with a message that does not repeat the setting, if the sender has no domain.
    this.domain = senderDomainOf(from);
    this.transporter = nodemailer.createTransport(options);
  }

  async send(message: MailMessage, options: SendOptions): Promise<TransportOutcome> {
    const ref = jobRefFor(options.idempotencyKey);
    const messageId = messageIdForRef(ref, this.domain);

    // Build the whole message first, then hand it over as a stream we can watch.
    const node = new MailComposer({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.body,
      messageId,
      headers: { "X-Job-Ref": ref },
    }).compile();
    const envelope = node.getEnvelope();
    const raw = await new Promise<Buffer>((resolve, reject) =>
      node.build((err, built) => (err ? reject(err) : resolve(built))),
    );

    let bodyPulled = false;
    const stream = new Readable({
      read() {
        bodyPulled = true;
        this.push(raw);
        this.push(null);
      },
    });

    try {
      const info = await this.transporter.sendMail({ envelope, raw: stream });
      if (info.accepted.length === 0) return { outcome: "refused", status: 550, retryable: false };
      return { outcome: "accepted", messageId };
    } catch (err) {
      return classifySmtpError(err, bodyPulled);
    }
  }
}
