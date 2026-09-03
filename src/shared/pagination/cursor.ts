import { z } from "zod";

export class BadCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadCursorError";
  }
}

const CursorValueSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  id: z.string().uuid(),
});

export type CursorValue = z.infer<typeof CursorValueSchema>;

export function encodeCursor(value: CursorValue): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeCursor(value: string): CursorValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new BadCursorError("cursor is not valid base64url JSON");
  }

  const result = CursorValueSchema.safeParse(parsed);
  if (!result.success) {
    throw new BadCursorError("cursor shape is invalid");
  }
  return result.data;
}
