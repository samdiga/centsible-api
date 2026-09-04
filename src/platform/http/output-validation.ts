import type { ZodType } from "zod";

import { OutputValidationError } from "../errors/app-error.js";

/** Validates server-produced output without misclassifying failures as client input errors. */
export function validateOutput<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new OutputValidationError();
  return result.data;
}
