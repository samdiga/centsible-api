import { z } from "zod";

export const NotificationPreferencesSchema = z.object({
  billRemindersEnabled: z.boolean(),
  billReminderDaysAhead: z.number().int().min(0).max(30),
  quietHoursEnabled: z.boolean(),
  quietHoursStart: z.number().int().min(0).max(23),
  quietHoursEnd: z.number().int().min(0).max(23),
});
export type NotificationPreferences = z.infer<
  typeof NotificationPreferencesSchema
>;

export const UpdateNotificationPreferencesSchema =
  NotificationPreferencesSchema.partial().refine(
    (value) => Object.keys(value).length > 0,
    { message: "At least one field required" },
  );
export type UpdateNotificationPreferences = z.infer<
  typeof UpdateNotificationPreferencesSchema
>;

export const NotificationPreferencesResponseSchema = z.object({
  preferences: NotificationPreferencesSchema,
});

export const ErrorEnvelopeSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
  requestId: z.string(),
});
