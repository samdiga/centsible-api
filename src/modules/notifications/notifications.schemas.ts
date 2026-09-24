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

export const PushPlatformSchema = z.enum(["ios", "android"]);
export type PushPlatform = z.infer<typeof PushPlatformSchema>;

export const PushEnvironmentSchema = z.enum(["sandbox", "production"]);
export type PushEnvironment = z.infer<typeof PushEnvironmentSchema>;

export const RegisterPushTokenSchema = z.object({
  token: z.string().min(1).max(4096),
  platform: PushPlatformSchema,
  environment: PushEnvironmentSchema,
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
