/** A wrong command line. Nothing has been called. */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
    this.code = "Usage";
    this.exit = 2;
  }
}

/** The refusal fields a caller prints. `code` decides; the message is for people. */
export function refusalOf(error) {
  return {
    code: error?.code || "Failed",
    message: error?.message || String(error),
    detail: error?.detail ?? null,
  };
}

export function isUsage(error) {
  return error instanceof UsageError || error?.exit === 2 || error?.code === "Usage";
}
