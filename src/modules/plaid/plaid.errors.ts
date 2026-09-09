import { AppError } from "../../platform/errors/app-error.js";

const TERMINAL_CODES = new Set([
  "ITEM_LOGIN_REQUIRED",
  "INVALID_ACCESS_TOKEN",
  "ITEM_NOT_FOUND",
]);

export class PlaidServiceError extends AppError {
  readonly isTerminal: boolean;

  constructor(
    readonly plaidCode: string,
    readonly plaidType: string,
    httpStatus: number,
    message: string,
  ) {
    super(
      `PLAID_${plaidCode}`,
      message,
      httpStatus,
      plaidCode === "ITEM_LOGIN_REQUIRED"
        ? "This connection needs to be re-linked."
        : "We hit a problem talking to your bank. Try again shortly.",
    );
    this.isTerminal = TERMINAL_CODES.has(plaidCode);
  }
}

export function plaidErrorCode(error: unknown): string {
  if (typeof error !== "object" || error === null) return "UNKNOWN";
  const response = (error as { response?: unknown }).response;
  if (typeof response !== "object" || response === null) return "UNKNOWN";
  const data = (response as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return "UNKNOWN";
  const code = (data as { error_code?: unknown }).error_code;
  return typeof code === "string" && code ? code : "UNKNOWN";
}
