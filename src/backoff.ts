// SKILLS: backoff-delay. The ONLY place delays are made (RULES 22). Equal jitter.
export function backoff(attempts: number, baseMs: number, capMs: number): { bound: number; delay: number } {
  const bound = Math.min(capMs, baseMs * 2 ** (attempts - 1));
  const delay = bound / 2 + Math.random() * (bound / 2); // <-- THE JITTER LINE
  return { bound, delay: Math.round(delay) };
}
