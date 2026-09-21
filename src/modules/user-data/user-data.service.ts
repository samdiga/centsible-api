import {
  createResponseCache,
  type ResponseCache,
} from "../../platform/cache/response-cache.js";
import {
  createWithUserMutation,
  type UserMutationService,
} from "../../platform/cache/user-revisions.repository.js";
import { getDb } from "../../platform/database/client.js";
import {
  ServiceUnavailableError,
  ValidationError,
} from "../../platform/errors/app-error.js";
import {
  consumeToken,
  type TokenBucketConfig,
} from "../../platform/http/rate-limit.js";
import { logger as runtimeLogger } from "../../platform/logging/logger.js";
import { redactLogValue } from "../../platform/logging/redaction.js";
import { BACKUP_VERSION, type BackupPayload } from "./user-data.schemas.js";
import {
  userDataRepository,
  type UserDataDb,
  type UserDataRepository,
} from "./user-data.repository.js";

export type { UserDataRepository } from "./user-data.repository.js";

const PAGE_SIZE = 5_000;
const EXPORT_LIMIT: TokenBucketConfig = {
  capacity: 5,
  refillPerMinute: 1,
};
const IMPORT_LIMIT: TokenBucketConfig = {
  capacity: 3,
  refillPerMinute: 0.5,
};

export type UserDataService = Readonly<{
  exportUserData: (userId: string) => Promise<ReadableStream<Uint8Array>>;
  importUserData: (userId: string, payload: BackupPayload) => Promise<void>;
  resetUserData: (userId: string) => Promise<void>;
}>;

export type UserDataServiceDependencies = Readonly<{
  repository?: UserDataRepository;
  cache?: Pick<ResponseCache, "invalidateUser">;
  withUserMutation?: UserMutationService["withUserMutation"];
  /** Plan 3 supplies the Plaid item-removal adapter required for destructive operations. */
  revokePlaidItems?: (userId: string) => Promise<void>;
  logger?: UserDataLogger;
  rateLimiter?: (key: string, config: TokenBucketConfig) => void;
}>;

export type UserDataLogger = Readonly<{
  error: (
    bindings: Record<string, unknown>,
    message: string,
  ) => void | PromiseLike<void>;
}>;

const defaultLogger: UserDataLogger = {
  error: (bindings, message) => runtimeLogger.error(bindings, message),
};

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function mutationDefault(
  cache: Pick<ResponseCache, "invalidateUser">,
): UserMutationService["withUserMutation"] {
  return createWithUserMutation({ db: getDb(), cache });
}

/** Builds a JSON export without retaining the full transaction array in memory. */
function createExportStream(
  metadata: Omit<BackupPayload, "transactions"> & { transactions: [] },
  listPage: UserDataRepository["listTransactionPage"],
  userId: string,
): ReadableStream<Uint8Array> {
  const serialized = JSON.stringify(metadata);
  const marker = '"transactions":[]';
  const markerIndex = serialized.indexOf(marker);
  if (markerIndex < 0) throw new Error("Export metadata omitted transactions");
  const prefix = `${serialized.slice(0, markerIndex)}"transactions":[`;
  const suffix = serialized.slice(markerIndex + marker.length);
  let prefixSent = false;
  let afterId: string | null = null;
  let wroteAny = false;
  let suffixNeeded = false;
  let cancelled = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (cancelled) return;
      try {
        if (!prefixSent) {
          prefixSent = true;
          controller.enqueue(encode(prefix));
          return;
        }
        if (suffixNeeded) {
          controller.enqueue(encode(`]${suffix}`));
          controller.close();
          return;
        }
        const page = await listPage(userId, afterId);
        if (cancelled) return;
        if (page.length === 0) {
          controller.enqueue(encode(`]${suffix}`));
          controller.close();
          suffixNeeded = true;
          return;
        }
        controller.enqueue(
          encode(
            `${wroteAny ? "," : ""}${page.map((row) => JSON.stringify(row)).join(",")}`,
          ),
        );
        wroteAny = true;
        if (page.length < PAGE_SIZE) {
          suffixNeeded = true;
        } else {
          const last = page[page.length - 1];
          if (!last) throw new Error("Export page was empty");
          afterId = last.id;
        }
      } catch (error: unknown) {
        controller.error(error);
      }
    },
    cancel() {
      cancelled = true;
    },
  });
}

export function createUserDataService(
  dependencies: UserDataServiceDependencies = {},
): UserDataService {
  const repository = dependencies.repository ?? userDataRepository;
  const cache = dependencies.cache ?? createResponseCache();
  const mutate: UserMutationService["withUserMutation"] =
    dependencies.withUserMutation ??
    ((userId, callback) => mutationDefault(cache)(userId, callback));
  const revokePlaidItems = dependencies.revokePlaidItems;
  const logger = dependencies.logger ?? defaultLogger;
  const rateLimiter = dependencies.rateLimiter ?? consumeToken;
  const revokeBeforeMutation = async (userId: string): Promise<void> => {
    if (!revokePlaidItems) throw new ServiceUnavailableError();
    try {
      await revokePlaidItems(userId);
    } catch (error) {
      try {
        await logger.error(
          { userId, error: redactLogValue(error) },
          "Plaid item revocation failed",
        );
      } catch {
        // Logging is best effort; destructive mutation must remain blocked.
      }
      throw new ServiceUnavailableError();
    }
  };

  return {
    async exportUserData(userId) {
      rateLimiter(`export:${userId}`, EXPORT_LIMIT);
      const metadata = await repository.exportMetadata(userId);
      return createExportStream(
        metadata,
        repository.listTransactionPage,
        userId,
      );
    },

    async importUserData(userId, payload) {
      rateLimiter(`import:${userId}`, IMPORT_LIMIT);
      if (payload.version !== BACKUP_VERSION) {
        throw new ValidationError(
          "This backup was exported by an older version of Centsy and can't be restored — export a fresh backup.",
        );
      }
      if (!revokePlaidItems) throw new ServiceUnavailableError();
      await repository.validateBackupReferences(userId, payload);
      await revokeBeforeMutation(userId);
      await mutate(userId, async (tx: UserDataDb) => {
        await repository.importUserData(userId, payload, tx);
        await repository.recordAudit(
          {
            userId,
            entityType: "user_data",
            entityId: userId,
            action: "update",
            source: "user.import",
          },
          tx,
        );
      });
    },

    async resetUserData(userId) {
      await revokeBeforeMutation(userId);
      await mutate(userId, async (tx: UserDataDb) => {
        await repository.resetUserData(userId, tx);
        await repository.recordAudit(
          {
            userId,
            entityType: "user_data",
            entityId: userId,
            action: "delete",
            source: "user.reset",
          },
          tx,
        );
      });
    },
  };
}

export const createUserData = createUserDataService;
