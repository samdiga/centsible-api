import pino from "pino";
import type { DestinationStream, Logger, LogFn } from "pino";
import { redactLogValue } from "./redaction.js";

const sensitiveMessage =
  /token|secret|password|account(?:number)?|transaction(?:name|description)?|payload|authorization|cookie|(?:postgres|mysql|mongodb)(?:ql)?:\/\//i;

function redactLogArgument(argument: unknown): unknown {
  if (typeof argument === "string" && sensitiveMessage.test(argument)) {
    return "[REDACTED]";
  }
  return redactLogValue(argument);
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
        return (bindings: Record<string, unknown>) =>
          wrapLogger(
            target.child(redactLogValue(bindings) as Record<string, unknown>),
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
