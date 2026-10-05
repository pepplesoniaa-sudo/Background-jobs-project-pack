import { createHash } from "node:crypto";

// Traceability without exposing the job id (owner's ruling). No header of any email carries the raw
// job id. Instead each email carries a short, one-way label of it, in the X-Job-Ref header and in its
// Message-ID. A person can match an email to a job by that label; nobody can get the job id back.
export const JOB_REF_LENGTH = 20;

// First 20 hex characters of the SHA-256 of the job id.
export const jobRefFor = (jobId: string): string =>
  createHash("sha256").update(jobId).digest("hex").slice(0, JOB_REF_LENGTH);

// The domain of the configured sender (EMAIL_FROM), for the Message-ID. It is read by the worker only,
// never printed, and the web process never sees it. The error text never repeats the input.
export function senderDomainOf(from: string): string {
  const inside = /<([^<>]*)>\s*$/.exec(from.trim());
  const address = (inside ? inside[1] : from).trim();
  const at = address.lastIndexOf("@");
  const domain = at === -1 ? "" : address.slice(at + 1).trim().toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    throw new Error("EMAIL_FROM must hold a sender address with a domain");
  }
  return domain;
}

export const messageIdForRef = (ref: string, domain: string): string => `<${ref}@${domain}>`;
