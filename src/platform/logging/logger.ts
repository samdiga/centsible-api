import pino from "pino";
import type {
  ChildLoggerOptions,
  DestinationStream,
  Logger,
  LogFn,
} from "pino";
import { redactLogValue } from "./redaction.js";

/**
 * "strict" (default): every string argument - including the log message
 * itself - is fully replaced, on top of the field-name-based object
 * redaction below. "partial": strings pass through untouched (log
 * messages become readable again); objects still go through
 * `redactLogValue`, so token/secret/password-shaped fields stay redacted.
 * "none": no redaction at all. Local-only; never set this outside a
 * developer's own machine.
 */
type RedactionMode = "strict" | "partial" | "none";

function resolveRedactionMode(): RedactionMode {
  const value = process.env.LOG_REDACTION_MODE;
  return value === "partial" || value === "none" ? value : "strict";
}

const redactionMode = resolveRedactionMode();

function redactLogArgument(argument: unknown): unknown {
  if (redactionMode === "none") return argument;
  if (typeof argument === "string") {
    return redactionMode === "partial" ? argument : "[REDACTED]";
  }
  return redactLogValue(argument);
}

const NY_TIMESTAMP_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** `MM-dd-yyyy HH:mm:ss` in America/New_York, for pino's `timestamp` option. */
function nyTimestamp(): string {
  const parts = Object.fromEntries(
    NY_TIMESTAMP_FORMAT.formatToParts(new Date()).map((part) => [
      part.type,
      part.value,
    ]),
  );
  return `,"time":"${parts.month}-${parts.day}-${parts.year} ${parts.hour}:${parts.minute}:${parts.second}"`;
}

function redactChildOptions(
  options: ChildLoggerOptions | undefined,
): ChildLoggerOptions | undefined {
  if (!options || typeof options.msgPrefix !== "string") return options;
  return { ...options, msgPrefix: "[REDACTED]" };
}

const loggerOptions = {
  level: process.env.LOG_LEVEL ?? "info",
  timestamp: nyTimestamp,
  formatters: {
    bindings(bindings: Record<string, unknown>) {
      return redactLogValue(bindings) as Record<string, unknown>;
    },
  },
  hooks: {
    logMethod(this: Logger, inputArguments: Parameters<LogFn>, method: LogFn) {
      method.apply(
        this,
        inputArguments.map(redactLogArgument) as [
          obj: unknown,
          msg?: string,
          ...args: unknown[],
        ],
      );
    },
  },
};

/** Longest serialized structured-data string kept on one log line. */
export const LOG_DATA_MAX_CHARS = 50;

const LOG_METHODS = new Set([
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
]);

type LogData = Record<string, unknown>;

function isLogData(value: unknown): value is LogData {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Serialize already-redacted structured data and keep only its first
 * `LOG_DATA_MAX_CHARS` characters. Callers must redact first so a secret can
 * never be half-printed.
 */
export function truncateLogData(data: LogData): string | undefined {
  if (Object.keys(data).length === 0) return undefined;
  let serialized: string;
  try {
    serialized = JSON.stringify(data, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    );
  } catch {
    return "[Unserializable]";
  }
  if (serialized.length <= LOG_DATA_MAX_CHARS) return serialized;
  let end = LOG_DATA_MAX_CHARS;
  const lastCode = serialized.charCodeAt(end - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) end -= 1;
  return serialized.slice(0, end);
}

/**
 * Replace a log call's structured argument with `{ data }`: the call's own
 * fields first (so path/status survive the cut), then the child bindings,
 * redacted, serialized and truncated. The message and its interpolation
 * arguments are redacted as before but never truncated.
 */
function toLogArguments(bindings: LogData, args: unknown[]): unknown[] {
  const [first, ...rest] = args;
  const hasObject = typeof first === "object" && first !== null;
  const callData: LogData = {};
  if (hasObject) {
    const redacted = redactLogValue(first);
    if (isLogData(redacted)) Object.assign(callData, redacted);
    else callData.value = redacted;
  }
  const merged: LogData = { ...callData };
  for (const [key, value] of Object.entries(bindings)) {
    if (!(key in merged)) merged[key] = value;
  }

  const messageArgs = (hasObject ? rest : args).map(redactLogArgument);
  const data = truncateLogData(merged);
  return data === undefined ? messageArgs : [{ data }, ...messageArgs];
}

/**
 * Build a Pino logger whose structured data (call fields plus child
 * bindings) is redacted, then emitted as one `data` string cut to
 * `LOG_DATA_MAX_CHARS`. The message stays whole.
 */
export function createLogger(destination?: DestinationStream): Logger {
  return wrapLogger(pino(loggerOptions, destination), {});
}

function wrapLogger(instance: Logger, bindings: LogData): Logger {
  return new Proxy(instance, {
    get(target, property, receiver) {
      if (property === "child") {
        return (childBindings: LogData, options?: ChildLoggerOptions) => {
          const redacted = redactLogValue(childBindings);
          return wrapLogger(target.child({}, redactChildOptions(options)), {
            ...bindings,
            ...(isLogData(redacted) ? redacted : {}),
          });
        };
      }

      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (typeof property === "string" && LOG_METHODS.has(property)) {
        return (...args: unknown[]) =>
          value.apply(target, toLogArguments(bindings, args));
      }
      return (...args: unknown[]) =>
        value.apply(target, args.map(redactLogArgument));
    },
  }) as Logger;
}

export const logger = createLogger();

export { redactLogValue } from "./redaction.js";
