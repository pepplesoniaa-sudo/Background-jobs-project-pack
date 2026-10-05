import type { Pool } from "pg";
import type { UncertainSendPolicy } from "./config.js";
import { SendError } from "./errors.js";
import type { MailMessage, MailTransport } from "./transport.js";

export interface SendEmailDeps {
  pool: Pool;
  transport: MailTransport;
  sendTimeoutMs: number;
  uncertainSendPolicy: UncertainSendPolicy;
}

// SKILLS: send-email-safely. Safe to run twice for the same job id.
export async function sendEmailSafely(deps: SendEmailDeps, jobId: string, message: MailMessage): Promise<void> {
  const { pool, transport, sendTimeoutMs, uncertainSendPolicy } = deps;

  // 1. Already sent: send nothing.
  const current = await pool.query<{ state: string }>(`SELECT state FROM sent_emails WHERE job_id = $1`, [jobId]);
  if (current.rows[0]?.state === "sent") return;

  // 2. Claim the right to send. A row back means this try is the first.
  const inserted = await pool.query(
    `INSERT INTO sent_emails (job_id, state) VALUES ($1, 'sending')
     ON CONFLICT (job_id) DO NOTHING RETURNING job_id`,
    [jobId],
  );
  if (inserted.rowCount === 0) {
    const existing = await pool.query<{ state: string }>(`SELECT state FROM sent_emails WHERE job_id = $1`, [jobId]);
    if (existing.rows[0]?.state === "sent") return;
    // An earlier try ended with an unknown outcome.
    if (uncertainSendPolicy === "flag_for_human") throw new SendError("uncertain send", "permanent");
    // resend: fall through with the same key, the provider dedupes.
  }

  // 3. Call the transport. The job id is the provider idempotency key.
  const result = await transport.send(message, { idempotencyKey: jobId, timeoutMs: sendTimeoutMs });

  // 4. Outcome.
  if (result.outcome === "accepted") {
    // The mail server took the message, so this is recorded EVEN IF this worker has lost the job
    // meanwhile: it is a fact about the email, not about the job, and a later attempt must see it.
    // Guarded: it only moves "sending" to "sent". A row that is already "sent" is left alone, and
    // nothing here can ever turn "sent" back into "sending".
    await pool.query(
      `UPDATE sent_emails SET state = 'sent', provider_message_id = $2, updated_at = now()
       WHERE job_id = $1 AND state = 'sending'`,
      [jobId, result.messageId],
    );
    return;
  }
  if (result.outcome === "refused") {
    // We KNOW it was not sent, so the sending row must not poison a later retry.
    await pool.query(`DELETE FROM sent_emails WHERE job_id = $1 AND state = 'sending'`, [jobId]);
    // 429 is retryable, any other 4xx is permanent, unless the transport says otherwise.
    const retryable = result.retryable ?? result.status === 429;
    throw new SendError(result.summary ?? `provider refused with ${result.status}`, retryable ? "retryable" : "permanent");
  }
  // Unknown outcome: leave the row as sending.
  throw new SendError(`provider outcome unknown: ${result.reason}`, "retryable");
}
