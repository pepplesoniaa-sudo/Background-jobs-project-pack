// S4: is this a well-formed single recipient address? It decides only the SHAPE. A well-formed address
// whose mailbox does not exist still passes: nothing can prove a mailbox exists before sending.
//
// Each failure gives a short phrase that completes "payload.to ...". The phrases never repeat the
// input, so an address cannot leak through an error message or a log.

export type RecipientCheck = { ok: true } | { ok: false; message: string };

const fail = (message: string): RecipientCheck => ({ ok: false, message });

const MAX_ADDRESS_LENGTH = 254;
const MAX_LOCAL_LENGTH = 64;
// Plain ASCII local part (no quoted strings, no comments). The dot rules are checked separately.
const LOCAL_CHARS = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;
const DOMAIN_LABEL = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
// The last label: starts with a letter, at least 2 characters, so "a@b.c" and "a@1.2.3.4" are refused.
const TOP_LABEL = /^[A-Za-z][A-Za-z0-9-]*[A-Za-z0-9]$/;

export function validateRecipient(value: unknown): RecipientCheck {
  if (value === undefined || value === null) return fail("is missing");
  if (typeof value !== "string") return fail("must be text");
  if (value.trim().length === 0) return fail("is empty");
  if (/\s/.test(value)) return fail("must not contain spaces");
  // More than one address, or a display-name form like Name <a@b.example>.
  if (/[,;<>"]/.test(value)) {
    return fail("must be one plain address, with no commas, semicolons, quotes or angle brackets");
  }
  if (value.split("@").length !== 2) return fail("must contain exactly one @");

  const [local, domain] = value.split("@");
  if (local.length === 0) return fail("needs a name before the @");
  if (domain.length === 0) return fail("needs a domain after the @");
  if (value.length > MAX_ADDRESS_LENGTH || local.length > MAX_LOCAL_LENGTH) return fail("is too long");
  if (!LOCAL_CHARS.test(local) || local.startsWith(".") || local.endsWith(".") || local.includes("..")) {
    return fail("has characters or dots that are not allowed before the @");
  }

  const labels = domain.split(".");
  const top = labels[labels.length - 1];
  if (labels.length < 2 || !labels.every((l) => DOMAIN_LABEL.test(l)) || !TOP_LABEL.test(top)) {
    return fail("must have a domain that looks like name.tld");
  }
  return { ok: true };
}
