export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.message === "timeout");
}
