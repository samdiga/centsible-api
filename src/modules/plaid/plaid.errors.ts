import { AppError } from "../../platform/errors/app-error.js";
import type { DuplicateItemDetails } from "./plaid.schemas.js";

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

/**
 * The link would add a bank account the user already has on another
 * connection. Plaid's guidance: don't exchange the public token, send the user
 * to update mode on the existing Item instead.
 */
export class DuplicateItemError extends AppError {
  constructor(details: DuplicateItemDetails) {
    super(
      "PLAID_DUPLICATE_ITEM",
      "Account already linked on another connection",
      409,
      "You already have this account in Centsy. Fix that connection instead.",
      details,
    );
  }
}

/**
 * What a Plaid support ticket needs about a failed request: its request id
 * and Plaid's developer-facing error fields.
 */
export function plaidErrorDetails(error: unknown): Readonly<{
  requestId: string | null;
  errorType: string | null;
  errorCode: string;
  errorMessage: string | null;
}> {
  const data = (error as { response?: { data?: unknown } } | null)?.response
    ?.data;
  const field = (key: string): string | null => {
    const value =
      typeof data === "object" && data !== null
        ? (data as Record<string, unknown>)[key]
        : undefined;
    return typeof value === "string" && value ? value : null;
  };
  return {
    requestId: field("request_id"),
    errorType: field("error_type"),
    errorCode: plaidErrorCode(error),
    errorMessage: field("error_message"),
  };
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
