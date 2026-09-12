import { z } from "zod";

export const TagIdSchema = z.string().uuid();
const TagColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .nullable();

export const TagDtoSchema = z.object({
  id: TagIdSchema,
  name: z.string(),
  color: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
});
export type TagDto = z.infer<typeof TagDtoSchema>;

export const TagListResponseSchema = z.object({
  tags: z.array(TagDtoSchema),
});

export const CreateTagBodySchema = z.object({
  name: z.string().trim().min(1).max(40),
  color: TagColorSchema.optional(),
});
export type CreateTagInput = z.infer<typeof CreateTagBodySchema>;

export const UpdateTagBodySchema = z
  .object({
    name: z.string().trim().min(1).max(40),
    color: TagColorSchema,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field required",
  });
export type UpdateTagInput = z.infer<typeof UpdateTagBodySchema>;
