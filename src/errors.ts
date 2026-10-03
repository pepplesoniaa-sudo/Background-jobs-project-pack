// FR6: retryable (timeout, network, 5xx, 429) versus permanent (any other 4xx, uncertain send).
// Sorting these into failed/dead is S4. S3 only needs the two kinds to exist.
export class SendError extends Error {
  constructor(
    message: string,
    readonly kind: "retryable" | "permanent",
  ) {
    super(message);
    this.name = "SendError";
  }
}
