import {
  createResponseCache,
  type ResponseCache,
} from "../../platform/cache/response-cache.js";
import {
  createWithUserMutation,
  getUserRevision,
  type UserMutationService,
} from "../../platform/cache/user-revisions.repository.js";
import { getDb } from "../../platform/database/client.js";
import type { DbTransaction } from "../../platform/database/types.js";
import {
  notificationPreferencesRepository,
  type NotificationPreferencesRepository,
  type NotificationPreferencesRow,
} from "./notifications.repository.js";
import type {
  NotificationPreferences,
  UpdateNotificationPreferences,
} from "./notifications.schemas.js";

export type NotificationPreferencesService = Readonly<{
  getPreferences: (userId: string) => Promise<NotificationPreferences>;
  updatePreferences: (
    userId: string,
    input: UpdateNotificationPreferences,
  ) => Promise<NotificationPreferences>;
}>;

export type NotificationPreferencesServiceDependencies = Readonly<{
  repository?: NotificationPreferencesRepository;
  cache?: Pick<ResponseCache, "getOrCompute" | "invalidateUser">;
  getUserRevision?: (userId: string) => Promise<bigint>;
  withUserMutation?: UserMutationService["withUserMutation"];
}>;

function toPreferencesDto(
  row: NotificationPreferencesRow,
): NotificationPreferences {
  // Keep this mapper JSON-safe and deliberately leave contract validation to
  // the HTTP boundary, which can classify invalid server output as INTERNAL.
  return {
    billRemindersEnabled: row.billRemindersEnabled,
    billReminderDaysAhead: row.billReminderDaysAhead,
    quietHoursEnabled: row.quietHoursEnabled,
    quietHoursStart: row.quietHoursStart,
    quietHoursEnd: row.quietHoursEnd,
  };
}

export function createNotificationsService(
  dependencies: NotificationPreferencesServiceDependencies = {},
): NotificationPreferencesService {
  const repository =
    dependencies.repository ?? notificationPreferencesRepository;
  const cache = dependencies.cache ?? createResponseCache();
  const readRevision =
    dependencies.getUserRevision ??
    ((userId: string) => getUserRevision(userId, getDb()));
  const mutate: UserMutationService["withUserMutation"] =
    dependencies.withUserMutation ??
    ((userId, callback) =>
      createWithUserMutation({ db: getDb(), cache })(userId, callback));

  return {
    async getPreferences(userId) {
      const revision = await readRevision(userId);
      return cache.getOrCompute(
        {
          userId,
          method: "GET",
          route: "/notifications/preferences",
          query: {},
          revision,
        },
        async () =>
          toPreferencesDto(await repository.getOrCreatePreferences(userId)),
      );
    },

    async updatePreferences(userId, input) {
      if (typeof repository.recordAudit !== "function") {
        throw new Error(
          "Notification preferences audit capability is required",
        );
      }
      return mutate(userId, async (tx: DbTransaction) => {
        const before = await repository.getOrCreatePreferences(userId, tx);
        const after = await repository.updatePreferences(userId, input, tx);
        await repository.recordAudit(
          {
            userId,
            before: toPreferencesDto(before),
            after: toPreferencesDto(after),
          },
          tx,
        );
        return toPreferencesDto(after);
      });
    },
  };
}

export const createNotificationService = createNotificationsService;

export { toPreferencesDto };
