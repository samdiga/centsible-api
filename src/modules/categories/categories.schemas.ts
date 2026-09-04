import { z } from "zod";

export const CategoryIdSchema = z.string().uuid();

export const CategoryDtoSchema = z.object({
  id: CategoryIdSchema,
  parentId: CategoryIdSchema.nullable(),
  name: z.string(),
  icon: z.string().nullable(),
  color: z.string().nullable(),
  isIncome: z.boolean(),
  isTransfer: z.boolean(),
  excludeFromBudgets: z.boolean(),
  displayOrder: z.number().int(),
  isCustom: z.boolean(),
});
export type CategoryDto = z.infer<typeof CategoryDtoSchema>;

export const CategoryListResponseSchema = z.object({
  categories: z.array(CategoryDtoSchema),
});

export const CreateCategoryBodySchema = z.object({
  name: z.string().min(1).max(60),
  icon: z.string().max(40).nullable().optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  isIncome: z.boolean().optional().default(false),
  excludeFromBudgets: z.boolean().optional().default(false),
  parentId: CategoryIdSchema.nullable().optional(),
});
export type CreateCategoryInput = z.infer<typeof CreateCategoryBodySchema>;

export const UpdateCategoryBodySchema = z
  .object({
    name: z.string().min(1).max(60),
    icon: z.string().max(40).nullable(),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .nullable(),
    excludeFromBudgets: z.boolean(),
    displayOrder: z.number().int(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field required",
  });
export type UpdateCategoryInput = z.infer<typeof UpdateCategoryBodySchema>;

export const CATEGORY_ICONS = [
  "home",
  "sofa",
  "wrench",
  "zap",
  "droplets",
  "flame",
  "trash-2",
  "utensils",
  "shopping-cart",
  "coffee",
  "wine",
  "pizza",
  "apple",
  "car",
  "bus",
  "train",
  "plane",
  "bike",
  "fuel",
  "heart-pulse",
  "pill",
  "stethoscope",
  "dumbbell",
  "leaf",
  "dollar-sign",
  "credit-card",
  "landmark",
  "trending-up",
  "piggy-bank",
  "receipt",
  "shopping-bag",
  "shirt",
  "tv",
  "smartphone",
  "gift",
  "music",
  "gamepad-2",
  "briefcase",
  "graduation-cap",
  "book-open",
  "laptop",
  "building-2",
  "users",
  "baby",
  "paw-print",
  "heart",
  "tag",
  "repeat",
  "arrow-left-right",
  "help-circle",
  "star",
  "globe",
  "shield",
  "map-pin",
  "hotel",
  "luggage",
] as const;

export type CategoryIconName = (typeof CATEGORY_ICONS)[number];
