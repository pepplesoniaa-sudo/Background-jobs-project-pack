// Masks a recipient for the dead letter view: first character and the domain stay, the rest hides.
export function maskRecipient(to: unknown): string {
  if (typeof to !== "string" || to.length === 0) return "[invalid]";
  const at = to.lastIndexOf("@");
  if (at <= 0) return `${to[0]}***`;
  return `${to[0]}***${to.slice(at)}`;
}

// Same payload with only the recipient masked (PRD FR10). Anything that is not an object is hidden.
export function maskPayload(payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return { to: "[invalid]" };
  const p = payload as Record<string, unknown>;
  return { ...p, to: maskRecipient(p.to) };
}
