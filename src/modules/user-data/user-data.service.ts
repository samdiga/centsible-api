import {
  createResponseCache,
  type ResponseCache,
} from "../../platform/cache/response-cache.js";
import {
  createWithUserMutation,
  type UserMutationService,
} from "../../platform/cache/user-revisions.repository.js";
import { getDb } from "../../platform/database/client.js";
import { ValidationError } from "../../platform/errors/app-error.js";
import { BACKUP_VERSION, type BackupPayload } from "./user-data.schemas.js";
import {
  userDataRepository,
  type UserDataDb,
  type UserDataRepository,
} from "./user-data.repository.js";

export type { UserDataRepository } from "./user-data.repository.js";

const PAGE_SIZE = 5_000;

export type UserDataService = Readonly<{
  exportUserData: (userId: string) => Promise<ReadableStream<Uint8Array>>;
  importUserData: (userId: string, payload: BackupPayload) => Promise<void>;
  resetUserData: (userId: string) => Promise<void>;
}>;

export type UserDataServiceDependencies = Readonly<{
  repository?: UserDataRepository;
  cache?: Pick<ResponseCache, "invalidateUser">;
  withUserMutation?: UserMutationService["withUserMutation"];
  /** Plan 3 supplies the Plaid item-removal adapter; this is a no-op for now. */
  revokePlaidItems?: (userId: string) => Promise<void>;
}>;

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
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const serialized = JSON.stringify(metadata);
        const marker = '"transactions":[]';
        const markerIndex = serialized.indexOf(marker);
        if (markerIndex < 0)
          throw new Error("Export metadata omitted transactions");
        controller.enqueue(
          encode(`${serialized.slice(0, markerIndex)}"transactions":[`),
        );
        let afterId: string | null = null;
        let wroteAny = false;
        for (;;) {
          const page = await listPage(userId, afterId);
          if (page.length === 0) break;
          controller.enqueue(
            encode(
              `${wroteAny ? "," : ""}${page.map((row) => JSON.stringify(row)).join(",")}`,
            ),
          );
          wroteAny = true;
          if (page.length < PAGE_SIZE) break;
          const last = page[page.length - 1];
          if (!last) throw new Error("Export page was empty");
          afterId = last.id;
        }
        controller.enqueue(encode("]}"));
        controller.close();
      } catch (error: unknown) {
        controller.error(error);
      }
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
  const revokePlaidItems =
    dependencies.revokePlaidItems ?? (async () => undefined);

  return {
    async exportUserData(userId) {
      const metadata = await repository.exportMetadata(userId);
      return createExportStream(
        metadata,
        repository.listTransactionPage,
        userId,
      );
    },

    async importUserData(userId, payload) {
      if (payload.version !== BACKUP_VERSION) {
        throw new ValidationError(
          `Backup version ${payload.version} is not supported.`,
        );
      }
      await repository.validateBackupReferences(userId, payload);
      await revokePlaidItems(userId);
      await mutate(userId, async (tx: UserDataDb) => {
        await repository.importUserData(userId, payload, tx);
        if (!repository.recordAudit) {
          throw new Error("User data audit capability is required");
        }
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
      await revokePlaidItems(userId);
      await mutate(userId, async (tx: UserDataDb) => {
        await repository.resetUserData(userId, tx);
        if (!repository.recordAudit) {
          throw new Error("User data audit capability is required");
        }
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
