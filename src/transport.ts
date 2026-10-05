import { randomUUID } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";

export interface MailMessage {
  to: string;
  subject: string;
  body: string;
}

export interface SendOptions {
  idempotencyKey: string;
  timeoutMs: number;
}

export type TransportOutcome =
  | { outcome: "accepted"; messageId: string }
  // We KNOW nothing was sent. `retryable` overrides the default (only 429 is retryable): an SMTP 4xx
  // is a temporary refusal and an SMTP 5xx is a permanent one. `summary` replaces the plain
  // "provider refused with <status>" in last_error where that would mislead (a login failure, or a
  // rejection made by the mail library itself). It is short and never holds an address.
  | { outcome: "refused"; status: number; retryable?: boolean; summary?: string }
  | { outcome: "unknown"; reason: string }; // timeout, network drop, 5xx: outcome UNKNOWN

export interface MailTransport {
  send(message: MailMessage, options: SendOptions): Promise<TransportOutcome>;
}

interface MailboxEntry {
  idempotencyKey: string;
  messageId: string;
}

// File-backed so a message survives a killed worker and is visible to a second process.
// It stores the idempotency key and message id only, never an address or body.
export async function readMailbox(path: string): Promise<MailboxEntry[]> {
  try {
    const text = await readFile(path, "utf8");
    return text
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as MailboxEntry);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

// SIMULATES provider dedupe: a key already recorded returns the first message id and records nothing.
export class FakeTransport implements MailTransport {
  constructor(
    private readonly mailboxPath: string,
    private readonly delayMs: number,
    private readonly forceFail = false,
  ) {}

  async send(_message: MailMessage, options: SendOptions): Promise<TransportOutcome> {
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    // FORCE_FAIL: a retryable 503. Like any 5xx the outcome is unknown, so nothing is recorded.
    if (this.forceFail) return { outcome: "unknown", reason: "provider 503" };
    const existing = (await readMailbox(this.mailboxPath)).find((e) => e.idempotencyKey === options.idempotencyKey);
    if (existing) return { outcome: "accepted", messageId: existing.messageId };
    const entry: MailboxEntry = { idempotencyKey: options.idempotencyKey, messageId: randomUUID() };
    await appendFile(this.mailboxPath, JSON.stringify(entry) + "\n");
    return { outcome: "accepted", messageId: entry.messageId };
  }
}
