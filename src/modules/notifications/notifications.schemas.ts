import { z } from "zod";

export const NotificationPreferencesSchema = z.object({
  billRemindersEnabled: z.boolean(),
  billReminderDaysAhead: z.number().int().min(0).max(30),
  quietHoursEnabled: z.boolean(),
  quietHoursStart: z.number().int().min(0).max(23),
  quietHoursEnd: z.number().int().min(0).max(23),
  syncAlertsEnabled: z.boolean(),
});
export type NotificationPreferences = z.infer<
  typeof NotificationPreferencesSchema
>;

/**
 * What the API returns: the editable settings plus whether the server is
 * sending bill reminders as push, so the app can stop scheduling its own
 * local ones and avoid duplicates.
 */
export const NotificationPreferencesViewSchema =
  NotificationPreferencesSchema.extend({
    billReminderPushActive: z.boolean(),
  });
export type NotificationPreferencesView = z.infer<
  typeof NotificationPreferencesViewSchema
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
  preferences: NotificationPreferencesViewSchema,
});

export const PushPlatformSchema = z.enum(["ios", "android"]);
export type PushPlatform = z.infer<typeof PushPlatformSchema>;

export const PushEnvironmentSchema = z.enum(["sandbox", "production"]);
export type PushEnvironment = z.infer<typeof PushEnvironmentSchema>;

const isTimeZone = (zone: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format();
    return true;
  } catch {
    return false;
  }
};

export const RegisterPushTokenSchema = z.object({
  token: z.string().min(1).max(4096),
  platform: PushPlatformSchema,
  environment: PushEnvironmentSchema,
  /** The device's IANA time zone, so server reminders arrive at 9 AM local. */
  timeZone: z
    .string()
    .min(1)
    .max(64)
    .refine(isTimeZone, { message: "Unknown time zone" })
    .optional(),
  /** The device's Blur amounts setting; amounts stay out of pushes when on. */
  hideAmounts: z.boolean().optional(),
});
export type RegisterPushToken = z.infer<typeof RegisterPushTokenSchema>;

export const PushTokenResponseSchema = z.object({
  registered: z.literal(true),
});

export const ClearPushTokenResponseSchema = z.object({
  cleared: z.literal(true),
});

export const ErrorEnvelopeSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
  requestId: z.string(),
});
