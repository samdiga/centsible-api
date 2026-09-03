export type ValidationPath = ReadonlyArray<string | number>;
export type ValidationIssue = Readonly<{
  path: ValidationPath;
  code: string;
}>;

export class AppError extends Error {
  readonly details: unknown;

  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
    readonly userMessage: string = message,
    details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
    this.details = details;
  }
}

export class AuthenticationError extends AppError {
  constructor(message = "Not authenticated") {
    super("UNAUTHENTICATED", message, 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super("FORBIDDEN", message, 403);
  }
}

export class NotFoundError extends AppError {
  constructor(entity = "resource") {
    super(
      "NOT_FOUND",
      `${entity} not found`,
      404,
      `We couldn't find that ${entity}.`,
    );
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflict") {
    super("CONFLICT", message, 409);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, issues?: ReadonlyArray<ValidationIssue>) {
    super("VALIDATION", message, 400, message, issues);
  }
}

export class RateLimitError extends AppError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds = 60) {
    super(
      "RATE_LIMITED",
      "rate limit exceeded",
      429,
      "Too many refreshes. Try again in a minute.",
    );
    this.retryAfterSeconds = Number.isFinite(retryAfterSeconds)
      ? Math.max(1, Math.floor(retryAfterSeconds))
      : 60;
  }
}

export class UpstreamError extends AppError {
  constructor(message = "Upstream service unavailable") {
    super(
      "UPSTREAM_FAILURE",
      message,
      502,
      "An upstream service is unavailable. Please try again.",
    );
  }
}
