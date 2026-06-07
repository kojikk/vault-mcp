/**
 * Typed errors for the core. Tool handlers translate these into MCP errors.
 * `safeMessage` is the only text that may cross the trust boundary back to the
 * caller — it must never embed secrets.
 */
export type CoreErrorCode =
  | "OUTSIDE_VAULT"
  | "RESERVED_PATH"
  | "BAD_EXTENSION"
  | "NULL_BYTE"
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "NOT_A_FILE"
  | "NOT_A_DIRECTORY"
  | "LOCK_TIMEOUT"
  | "INVALID_NAME"
  | "TXN_FAILED";

export class CoreError extends Error {
  readonly code: CoreErrorCode;
  constructor(code: CoreErrorCode, message: string) {
    super(message);
    this.name = "CoreError";
    this.code = code;
  }
}

export function isCoreError(e: unknown): e is CoreError {
  return e instanceof CoreError;
}
