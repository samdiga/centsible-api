import pino from "pino";
import type {
  ChildLoggerOptions,
  DestinationStream,
  Logger,
  LogFn,
} from "pino";
import { redactLogValue } from "./redaction.js";

function redactLogArgument(argument: unknown): unknown {
  if (typeof argument === "string") return "[REDACTED]";
  return redactLogValue(argument);
}

function redactChildOptions(
  options: ChildLoggerOptions | undefined,
): ChildLoggerOptions | undefined {
  if (!options || typeof options.msgPrefix !== "string") return options;
  return { ...options, msgPrefix: "[REDACTED]" };
}

const loggerOptions = {
  level: process.env.LOG_LEVEL ?? "info",
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

/** Build a Pino logger whose root arguments and child bindings are redacted. */
export function createLogger(destination?: DestinationStream): Logger {
  return wrapLogger(pino(loggerOptions, destination));
}

function wrapLogger(instance: Logger): Logger {
  return new Proxy(instance, {
    get(target, property, receiver) {
      if (property === "child") {
        return (
          bindings: Record<string, unknown>,
          options?: ChildLoggerOptions,
        ) =>
          wrapLogger(
            target.child(
              redactLogValue(bindings) as Record<string, unknown>,
              redactChildOptions(options),
            ),
          );
      }

      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) =>
        value.apply(target, args.map(redactLogArgument));
    },
  }) as Logger;
}

export const logger = createLogger();

export { redactLogValue } from "./redaction.js";
