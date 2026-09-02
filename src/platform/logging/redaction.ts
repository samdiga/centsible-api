const REDACTED = "[REDACTED]";
const CIRCULAR = "[Circular]";

const sensitiveKey =
  /token|secret|password|accountNumber|transactionName|payload/i;
const defensiveSensitiveKey =
  /^(authorization|cookie|database(?:Url|_url)?|connection(?:String|_string|Url|_url)?|webhook(?:Url|_url)?|account(?:Number|_number)?|transactionDescription)$/i;

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function redactError(error: Error): Record<string, unknown> {
  const output: Record<string, unknown> = {
    name: error.name,
    message: REDACTED,
    stack: error.stack ? REDACTED : undefined,
  };

  for (const key of [
    "code",
    "type",
    "requestId",
    "request_id",
    "route",
    "status",
    "statusCode",
    "elapsedMs",
    "error_code",
    "error_type",
  ]) {
    if (key in error)
      output[key] = redact(
        (error as unknown as Record<string, unknown>)[key],
        new WeakSet<object>(),
      );
  }
  return output;
}

function redact(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined || typeof value !== "object")
    return value;
  if (seen.has(value)) return CIRCULAR;

  if (value instanceof Error) return redactError(value);
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof RegExp) return value;
  if (!Array.isArray(value) && !isPlainObject(value)) {
    const constructorName = value.constructor?.name ?? "Object";
    return `[${constructorName}]`;
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => redact(entry, seen));

    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] =
        sensitiveKey.test(key) || defensiveSensitiveKey.test(key)
          ? REDACTED
          : redact(entry, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

/** Return a safe, non-mutating copy suitable for structured logging. */
export function redactLogValue(value: unknown): unknown {
  return redact(value, new WeakSet<object>());
}

export { REDACTED };
