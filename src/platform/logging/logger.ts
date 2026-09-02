import pino from "pino";
import { redactLogValue } from "./redaction.js";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  formatters: {
    bindings(bindings) {
      return redactLogValue(bindings) as Record<string, unknown>;
    },
  },
  hooks: {
    logMethod(inputArguments, method) {
      method.apply(
        this,
        inputArguments.map((argument) => redactLogValue(argument)) as [
          obj: unknown,
          msg?: string,
          ...args: unknown[],
        ],
      );
    },
  },
});

export { redactLogValue } from "./redaction.js";
