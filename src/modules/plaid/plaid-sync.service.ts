import { getDb } from "../../platform/database/client.js";
import type { Db, DbTransaction } from "../../platform/database/types.js";
import { auditLogRepository } from "../../platform/database/audit-log.repository.js";
import { createResponseCache } from "../../platform/cache/response-cache.js";
import {
  createWithUserMutation,
  type UserMutationService,
} from "../../platform/cache/user-revisions.repository.js";
import {
  createPlaidAccountWriter,
  type PlaidAccountWriter,
} from "../accounts/index.js";
import {
  createPlaidTransactionWriter,
  type PlaidTransactionWriter,
  type TransactionPatchFields,
  type TransactionRow,
} from "../transactions/index.js";
import {
  createRulesRepository,
  matchRules,
  type RuleForMatching,
  type RuleRepository,
} from "../rules/index.js";
import { createPlaidClient, type PlaidClientPort } from "./plaid.client.js";
import { decryptToken, type TokenCipher } from "./plaid.crypto.js";
import { plaidErrorCode, PlaidServiceError } from "./plaid.errors.js";
import {
  createPlaidItemsRepository,
  type PlaidItemsRepository,
} from "./plaid-items.repository.js";
import {
  createPlaidRawImportsRepository,
  type PlaidRawImportsRepository,
} from "./plaid-raw-imports.repository.js";

export type PlaidSyncResult = Readonly<{
  added: number;
  modified: number;
  removed: number;
  pages: number;
}>;

export type PlaidSyncService = Readonly<{
  syncItem: (userId: string, itemId: string) => Promise<PlaidSyncResult>;
}>;

type Dependencies = Readonly<{
  db?: Db;
  items?: Pick<
    PlaidItemsRepository,
    | "findByUuid"
    | "isFeatureEnabled"
    | "advanceCursor"
    | "markSynced"
    | "markStatus"
  >;
  client?: Pick<PlaidClientPort, "syncTransactions">;
  cipher?: Pick<TokenCipher, "decrypt">;
  accounts?: PlaidAccountWriter;
  transactions?: Pick<
    PlaidTransactionWriter,
    "upsertManyFromPlaid" | "softDeleteByPlaidIds" | "applyRuleMatch"
  >;
  rules?: Pick<RuleRepository, "listActiveRules">;
  rawImports?: Pick<PlaidRawImportsRepository, "record">;
  audit?: typeof auditLogRepository;
  transaction?: <T>(callback: (tx: DbTransaction) => Promise<T>) => Promise<T>;
  withUserMutation?: UserMutationService["withUserMutation"];
}>;

function rulePatch(
  row: TransactionRow,
  val?: RuleForMatching,
): TransactionPatchFields {
  const rule = val;
  if (!rule) return {};
  return {
    ...(rule.actionCategoryId ? { categoryId: rule.actionCategoryId } : {}),
    ...(rule.actionMemberId && !row.householdMemberId
      ? { householdMemberId: rule.actionMemberId }
      : {}),
    ...(rule.actionSetNotes && !row.notes
      ? { notes: rule.actionSetNotes }
      : {}),
    ...(rule.actionMarkReviewed && row.reviewStatus === "needs_review"
      ? { reviewStatus: "reviewed" as const }
      : {}),
    ...(rule.actionExcludeFromBudgets && !row.excludeFromBudgets
      ? { excludeFromBudgets: true }
      : {}),
  };
}

export function createPlaidSyncService(
  dependencies: Dependencies = {},
): PlaidSyncService {
  const database = (): Db => dependencies.db ?? getDb();
  const items = dependencies.items ?? createPlaidItemsRepository(database());
  const client = dependencies.client ?? createPlaidClient();
  const cipher = dependencies.cipher ?? { decrypt: decryptToken };
  const accounts =
    dependencies.accounts ?? createPlaidAccountWriter(database());
  const transactions =
    dependencies.transactions ?? createPlaidTransactionWriter(database());
  const rules = dependencies.rules ?? createRulesRepository(database());
  const rawImports =
    dependencies.rawImports ?? createPlaidRawImportsRepository(database());
  const audit = dependencies.audit ?? auditLogRepository;
  const transaction =
    dependencies.transaction ??
    (<T>(callback: (tx: DbTransaction) => Promise<T>) =>
      database().transaction(callback));
  const mutate: UserMutationService["withUserMutation"] =
    dependencies.withUserMutation ??
    (<T>(userId: string, callback: (tx: DbTransaction) => Promise<T>) =>
      createWithUserMutation({
        db: database(),
        cache: createResponseCache(),
      })(userId, callback));

  return {
    async syncItem(userId, itemId) {
      const item = await items.findByUuid(itemId);
      if (!item || item.userId !== userId)
        throw new PlaidServiceError(
          "UNKNOWN_ITEM",
          "sync",
          404,
          "Plaid item not found",
        );
      if (!(await items.isFeatureEnabled("plaid_ingestion_enabled", userId)))
        return { added: 0, modified: 0, removed: 0, pages: 0 };
      const accessToken = cipher.decrypt({
        encrypted: item.accessTokenEncrypted,
        nonce: item.accessTokenNonce,
      });
      const activeRules = (await rules.listActiveRules(userId)).map(
        (rule) => rule as RuleForMatching,
      );
      let cursor = item.cursor ?? undefined;
      let priorCursor = item.cursor ?? null;
      const result = { added: 0, modified: 0, removed: 0, pages: 0 };
      for (;;) {
        let page;
        try {
          page = await client.syncTransactions(accessToken, cursor);
        } catch (error) {
          const code = plaidErrorCode(error);
          const status =
            code === "ITEM_LOGIN_REQUIRED"
              ? "login_required"
              : code === "PENDING_EXPIRATION"
                ? "pending_expiration"
                : "error";
          await items.markStatus(item.id, status, code, "Plaid sync failed");
          throw new PlaidServiceError(code, "sync", 502, "Plaid sync failed");
        }
        const advanced = await transaction(async (tx) => {
          await rawImports.record(
            {
              userId,
              plaidItemId: item.id,
              endpoint: "transactions/sync",
              ...(cursor ? { cursor } : {}),
              payload: page.rawPayload,
            },
            tx,
          );
          const accountMap = new Map<string, string>();
          for (const account of page.accounts) {
            const saved = await accounts.upsertFromPlaid(
              { userId, plaidItemUuid: item.id, account },
              tx,
            );
            accountMap.set(account.account_id, saved.id);
          }
          const changed = [...page.added, ...page.modified];
          const missingAccountIds = [
            ...new Set(
              changed
                .map((entry) => entry.account_id)
                .filter((id) => !accountMap.has(id)),
            ),
          ];
          for (const account of await accounts.findByPlaidAccountIds(
            missingAccountIds,
            userId,
            tx,
          )) {
            if (account.plaidAccountId)
              accountMap.set(account.plaidAccountId, account.id);
          }
          const savedTransactions = await transactions.upsertManyFromPlaid(
            changed.map((entry) => {
              const accountId = accountMap.get(entry.account_id);
              if (!accountId)
                throw new PlaidServiceError(
                  "UNKNOWN_ACCOUNT",
                  "sync",
                  500,
                  "Transaction references unknown account",
                );
              return { userId, accountId, txn: entry };
            }),
            tx,
          );
          for (const row of savedTransactions) {
            if (row.userCategoryOverride || activeRules.length === 0) continue;
            const rule = matchRules(
              {
                merchantName: row.merchantName,
                name: row.name,
                amount: row.amount,
                accountId: row.accountId,
              },
              activeRules,
            );
            const patch = rulePatch(row, rule ?? undefined);
            if (Object.keys(patch).length > 0)
              await transactions.applyRuleMatch(row.id, userId, patch, tx);
          }
          const removedIds = page.removed
            .map((entry) => entry.transaction_id)
            .filter((id): id is string => typeof id === "string" && !!id);
          await transactions.softDeleteByPlaidIds(removedIds, userId, tx);
          return items.advanceCursor(item.id, priorCursor, page.nextCursor, tx);
        });
        result.added += page.added.length;
        result.modified += page.modified.length;
        result.removed += page.removed.filter(
          (entry) => typeof entry.transaction_id === "string",
        ).length;
        result.pages += 1;
        if (!advanced) break;
        priorCursor = page.nextCursor;
        cursor = page.nextCursor;
        if (!page.hasMore) {
          await items.markSynced(item.id);
          break;
        }
      }
      await mutate(userId, (tx) =>
        audit.record(
          {
            userId,
            entityType: "plaid_item",
            entityId: item.id,
            action: "sync",
            source: "plaid.sync",
            after: result,
          },
          tx,
        ),
      );
      return result;
    },
  };
}
