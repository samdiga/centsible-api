import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  accounts,
  auditLog,
  plaidItems,
  users,
} from "../../database/schema/index.js";
import {
  createAccountRepository,
  createPlaidAccountWriter,
  createPlaidBalanceWriter,
} from "../../src/modules/accounts/accounts.repository.js";
import { createAccountService } from "../../src/modules/accounts/accounts.service.js";
import { createBillOccurrencesRepository } from "../../src/modules/bills/bill-occurrences.repository.js";
import { createBillsRepository } from "../../src/modules/bills/bills.repository.js";
import { createBillsService } from "../../src/modules/bills/bills.service.js";
import {
  materializeBillsForUser,
  resolveMaturedForecastEvents,
  runBillDetection,
  runOverdueSweep,
} from "../../src/modules/bills/bills.service.js";
import { upsertStatementBills } from "../../src/modules/bills/statement-bills.js";
import { createBudgetRepository } from "../../src/modules/budgets/budgets.repository.js";
import { createBudgetsService } from "../../src/modules/budgets/budgets.service.js";
import { createCategoryRepository } from "../../src/modules/categories/categories.repository.js";
import { createCategoryService } from "../../src/modules/categories/categories.service.js";
import { createNetWorthSnapshotService } from "../../src/modules/dashboard/net-worth-snapshot.service.js";
import { createNotificationPreferencesRepository } from "../../src/modules/notifications/notifications.repository.js";
import { createNotificationsService } from "../../src/modules/notifications/notifications.service.js";
import { createPipelineRepository } from "../../src/modules/pipeline/pipeline.repository.js";
import { createPipelineService } from "../../src/modules/pipeline/pipeline.service.js";
import { createInboundEventHandler } from "../../src/modules/plaid/inbound-event-handler.js";
import { createPlaidLiabilitiesService } from "../../src/modules/plaid/plaid-liabilities.service.js";
import { createPlaidItemsRepository } from "../../src/modules/plaid/plaid-items.repository.js";
import { createPlaidRawImportsRepository } from "../../src/modules/plaid/plaid-raw-imports.repository.js";
import { createPlaidSyncService } from "../../src/modules/plaid/plaid-sync.service.js";
import { createPlaidService } from "../../src/modules/plaid/plaid.service.js";
import { applyRuleRetroactively } from "../../src/modules/rules/retroactive.js";
import { createRulesRepository } from "../../src/modules/rules/rules.repository.js";
import { createRuleService } from "../../src/modules/rules/rules.service.js";
import { createTransactionRepository } from "../../src/modules/transactions/transactions.repository.js";
import { createTransactionService } from "../../src/modules/transactions/transactions.service.js";
import { createPlaidTransactionWriter } from "../../src/modules/transactions/transactions.repository.js";
import { createUserDataRepository } from "../../src/modules/user-data/user-data.repository.js";
import {
  BACKUP_VERSION,
  type BackupPayload,
} from "../../src/modules/user-data/user-data.schemas.js";
import { createUserDataService } from "../../src/modules/user-data/user-data.service.js";
import {
  createResponseCache,
  type ResponseCache,
} from "../../src/platform/cache/response-cache.js";
import { createAuditLogRepository } from "../../src/platform/database/audit-log.repository.js";
import type { DbTransaction } from "../../src/platform/database/types.js";
import {
  createUserInvalidationListener,
  createWithUserMutation,
  getUserRevision,
  publishUserInvalidation,
} from "../../src/platform/cache/user-revisions.repository.js";
import {
  createIsolatedTestDatabase,
  readTestDatabaseConfig,
} from "../support/test-database.js";

function hasExternalTestDatabaseApproval(): boolean {
  try {
    readTestDatabaseConfig(process.env);
    return true;
  } catch {
    return false;
  }
}

const guardedDescribe = hasExternalTestDatabaseApproval()
  ? describe
  : describe.skip;

const cacheFamilies = [
  ["/dashboard/summary", {}],
  ["/accounts", {}],
  ["/transactions", { limit: ["1"] }],
  ["/reports/summary", { type: ["monthly_spending"] }],
  ["/forecast", { horizonDays: ["30"] }],
] as const;

async function primeEveryApplicableCacheFamily(
  cache: ResponseCache,
  userId: string,
  revision: bigint,
): Promise<void> {
  await Promise.all(
    cacheFamilies.map(([route, query]) =>
      cache.getOrCompute(
        {
          userId,
          method: "GET",
          route,
          query,
          revision,
          horizon: route === "/forecast" ? "30" : undefined,
        },
        async () => ({ route, cacheOnlyFixture: true }),
      ),
    ),
  );
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for worker cache invalidation");
}

guardedDescribe("cache invalidation after real user-scoped writes", () => {
  it("evicts every target cache family, advances its revision, leaves the control user intact, and recomputes after API and worker writes", async () => {
    const harness = await createIsolatedTestDatabase();
    const cache = createResponseCache();
    const targetUserId = randomUUID();
    const controlUserId = randomUUID();
    const listenerPeer = await harness.createPeerClient();
    const listener = createUserInvalidationListener({
      cache,
      listen: async (channel, onNotification) => {
        const subscription = await listenerPeer.client.listen(
          channel,
          onNotification,
        );
        return { unlisten: () => subscription.unlisten() };
      },
    });

    try {
      await listener.start();
      await harness.db.insert(users).values([
        {
          id: targetUserId,
          email: `${targetUserId}@example.test`,
          name: "Cache target",
        },
        {
          id: controlUserId,
          email: `${controlUserId}@example.test`,
          name: "Cache control",
        },
      ]);
      const targetItem = (
        await harness.db
          .insert(plaidItems)
          .values({
            userId: targetUserId,
            plaidItemId: `item-${randomUUID()}`,
            institutionId: "test_institution",
            institutionName: "Test institution",
            accessTokenEncrypted: "test_encrypted",
            accessTokenNonce: "test_nonce",
          })
          .returning()
      )[0];
      if (!targetItem) throw new Error("Expected a target item fixture");
      const repository = createAccountRepository(harness.db);
      const account = await repository.upsertFromPlaid({
        userId: targetUserId,
        plaidItemUuid: targetItem.id,
        account: {
          account_id: `account-${randomUUID()}`,
          name: "Test account",
          type: "depository",
          subtype: "checking",
          mask: "0000",
          balances: { current: 1, available: 1, iso_currency_code: "USD" },
        },
      });
      const statementAccount = await repository.upsertFromPlaid({
        userId: targetUserId,
        plaidItemUuid: targetItem.id,
        account: {
          account_id: `statement-account-${randomUUID()}`,
          name: "Test credit account",
          type: "credit",
          subtype: "credit card",
          mask: "1111",
          balances: { current: 2, available: 8, iso_currency_code: "USD" },
        },
      });
      await harness.db
        .update(accounts)
        .set({
          paymentDueDate: "2026-10-20",
          statementBalance: 200n,
        })
        .where(eq(accounts.id, statementAccount.id));
      const mutate = createWithUserMutation({
        db: harness.db,
        cache,
        publishInvalidation: (userId) =>
          publishUserInvalidation(userId, harness.db),
      });
      const accountService = createAccountService({
        repository,
        cache,
        getUserRevision: (userId) => getUserRevision(userId, harness.db),
        withUserMutation: mutate,
      });
      const transactionRepository = createTransactionRepository(harness.db);
      const transaction = await transactionRepository.upsertFromPlaid({
        userId: targetUserId,
        accountId: account.id,
        txn: {
          transaction_id: `transaction-${randomUUID()}`,
          amount: 1,
          date: "2026-09-11",
          pending: false,
          name: "Test transaction",
        },
      });
      const transactionService = createTransactionService({
        repository: transactionRepository,
        cache,
        getUserRevision: (userId) => getUserRevision(userId, harness.db),
        withUserMutation: mutate,
      });
      const categoryService = createCategoryService({
        repository: createCategoryRepository(harness.db),
        cache,
        getUserRevision: (userId) => getUserRevision(userId, harness.db),
        withUserMutation: mutate,
      });
      const notificationsService = createNotificationsService({
        repository: createNotificationPreferencesRepository(harness.db),
        cache,
        getUserRevision: (userId) => getUserRevision(userId, harness.db),
        withUserMutation: mutate,
      });
      const billsRepository = createBillsRepository(harness.db);
      const billOccurrences = createBillOccurrencesRepository(harness.db);
      const billsService = createBillsService({
        repository: billsRepository,
        occurrences: billOccurrences,
        cache,
        getUserRevision: (userId) => getUserRevision(userId, harness.db),
        withUserMutation: mutate,
        billDispatcher: {
          detect: async () => undefined,
          materialize: async () => undefined,
        },
      });
      const budgetsService = createBudgetsService({
        repository: createBudgetRepository(harness.db),
        cache,
        getUserRevision: (userId) => getUserRevision(userId, harness.db),
        withUserMutation: mutate,
      });
      const rulesRepository = createRulesRepository(harness.db);
      const rulesService = createRuleService({
        repository: rulesRepository,
        cache,
        getUserRevision: (userId) => getUserRevision(userId, harness.db),
        withUserMutation: mutate,
      });
      const pipelineService = createPipelineService({
        repository: createPipelineRepository(harness.db),
        db: harness.db,
        cache,
        withUserMutation: mutate,
      });
      const snapshotService = createNetWorthSnapshotService({
        listAccounts: async () => [
          {
            type: "depository",
            currentBalance: 100n,
            availableBalance: 100n,
            excludeFromNetWorth: false,
            excludeFromForecast: false,
          },
        ],
        withUserMutation: mutate,
        audit: createAuditLogRepository(harness.db).record,
      });
      const userDataService = createUserDataService({
        repository: createUserDataRepository(harness.db),
        cache,
        withUserMutation: mutate,
        revokePlaidItems: async () => undefined,
        rateLimiter: () => undefined,
      });
      const plaidItemsRepository = createPlaidItemsRepository(harness.db);
      const auditRepository = createAuditLogRepository(harness.db);
      const enabledPlaidItemsRepository = {
        ...plaidItemsRepository,
        isFeatureEnabled: async () => true,
      };
      const workerHandler = createInboundEventHandler({
        items: plaidItemsRepository,
        audit: auditRepository,
        withUserMutation: createWithUserMutation({
          db: harness.db,
          cache: { invalidateUser: () => undefined },
          publishInvalidation: (userId) =>
            publishUserInvalidation(userId, harness.db),
        }),
      });
      const plaidService = createPlaidService({
        db: harness.db,
        repository: enabledPlaidItemsRepository,
        client: {
          exchangePublicToken: async () => ({
            accessToken: "sandbox-cache-token",
            plaidItemId: `exchanged-item-${randomUUID()}`,
          }),
          removeItem: async () => undefined,
          getBalances: async () => [
            {
              account_id: statementAccount.plaidAccountId,
              balances: {
                current: 2,
                available: 8,
                limit: 10,
                iso_currency_code: "USD",
              },
            },
          ],
        } as never,
        cipher: {
          encrypt: () => ({ encrypted: "fixture-encrypted", nonce: "fixture" }),
          decrypt: () => "sandbox-cache-token",
        },
        accounts: createPlaidBalanceWriter(harness.db),
        audit: auditRepository,
        withUserMutation: mutate,
        cache,
        startPipeline: async () => ({ runId: randomUUID(), deduped: false }),
        consume: () => undefined,
        logger: { warn: () => undefined },
      });
      const plaidSyncService = createPlaidSyncService({
        db: harness.db,
        items: enabledPlaidItemsRepository,
        client: {
          syncTransactions: async () => ({
            added: [],
            modified: [],
            removed: [],
            accounts: [],
            nextCursor: `cursor-${randomUUID()}`,
            hasMore: false,
            rawPayload: { fixture: true },
          }),
        },
        cipher: { decrypt: () => "sandbox-cache-token" },
        accounts: createPlaidAccountWriter(harness.db),
        transactions: createPlaidTransactionWriter(harness.db),
        rules: rulesRepository,
        rawImports: createPlaidRawImportsRepository(harness.db),
        audit: auditRepository,
        transaction: <T>(callback: (tx: DbTransaction) => Promise<T>) =>
          harness.db.transaction(callback),
        withUserMutation: mutate,
      } as never);
      const plaidLiabilitiesService = createPlaidLiabilitiesService({
        repository: enabledPlaidItemsRepository,
        client: {
          getLiabilities: async () => ({
            credit: [
              {
                account_id: statementAccount.plaidAccountId,
                aprs: [],
                minimum_payment_amount: 1,
                next_payment_due_date: "2026-10-20",
                last_statement_balance: 2,
                last_statement_issue_date: "2026-09-20",
              },
            ],
            student: [],
            mortgage: [],
          }),
        },
        cipher: { decrypt: () => "sandbox-cache-token" },
        accounts: createPlaidBalanceWriter(harness.db),
        withUserMutation: mutate,
        audit: auditRepository,
      } as never);

      let createdCategoryId: string | undefined;
      let createdBillId: string | undefined;
      let paidOccurrenceId: string | undefined;
      let skippedOccurrenceId: string | undefined;
      let createdBudgetId: string | undefined;
      let createdRuleId: string | undefined;
      let exchangedItemId: string | undefined;
      const importedAccountId = randomUUID();
      const importPayload = {
        version: BACKUP_VERSION,
        exportedAt: "2026-09-12T00:00:00.000Z",
        accounts: [
          {
            id: importedAccountId,
            name: "Imported cache fixture",
            officialName: null,
            mask: null,
            type: "depository",
            subtype: "checking",
            currency: "USD",
            currentBalance: "0",
            availableBalance: null,
            isHidden: false,
          },
        ],
        transactions: [],
        categories: [],
        rules: [],
        budgets: [],
        recurring: [],
      } satisfies BackupPayload;
      const scenarios = [
        {
          name: "API category creation",
          expectedInvalidations: 2,
          write: async () => {
            createdCategoryId = (
              await categoryService.createCategory(targetUserId, {
                name: "Test category",
                isIncome: false,
                excludeFromBudgets: false,
              })
            ).id;
          },
        },
        {
          name: "API category update",
          expectedInvalidations: 2,
          write: () =>
            categoryService.updateCategory(targetUserId, createdCategoryId!, {
              name: "Updated category",
            }),
        },
        {
          name: "API transaction patch",
          expectedInvalidations: 2,
          write: () =>
            transactionService.patchTransaction(targetUserId, transaction.id, {
              reviewStatus: "reviewed",
            }),
        },
        {
          name: "API transaction bulk patch",
          expectedInvalidations: 2,
          write: () =>
            transactionService.bulkPatchTransactions(targetUserId, {
              ids: [transaction.id],
              patch: { excludeFromBudgets: true },
            }),
        },
        {
          name: "API notification-preferences update",
          expectedInvalidations: 2,
          write: () =>
            notificationsService.updatePreferences(targetUserId, {
              quietHoursEnabled: false,
            }),
        },
        {
          name: "API bill creation",
          expectedInvalidations: 2,
          write: async () => {
            createdBillId = (
              await billsService.createBill(targetUserId, {
                canonicalName: "Cache fixture bill",
                amountCents: 100n,
                cadence: "monthly",
                nextExpectedDate: "2026-10-15",
                isIncome: false,
                billType: "payable",
              })
            ).id;
            await billOccurrences.insertOccurrences([
              {
                userId: targetUserId,
                billSetupId: createdBillId,
                dueDate: "2026-10-15",
                expectedAmountCents: 100n,
              },
              {
                userId: targetUserId,
                billSetupId: createdBillId,
                dueDate: "2026-11-15",
                expectedAmountCents: 100n,
              },
            ]);
            const occurrences = await billOccurrences.listBySetup(
              targetUserId,
              createdBillId,
            );
            paidOccurrenceId = occurrences[0]?.id;
            skippedOccurrenceId = occurrences[1]?.id;
          },
        },
        {
          name: "API bill update",
          expectedInvalidations: 2,
          write: () =>
            billsService.updateBill(targetUserId, createdBillId!, {
              notes: "updated",
              userConfirmed: true,
            }),
        },
        {
          name: "API bill occurrence paid",
          expectedInvalidations: 2,
          write: () =>
            billsService.markOccurrencePaid(targetUserId, paidOccurrenceId!, {
              accountId: account.id,
              amountCents: 100n,
            }),
        },
        {
          name: "API bill occurrence skipped",
          expectedInvalidations: 2,
          write: () =>
            billsService.skipOccurrence(targetUserId, skippedOccurrenceId!),
        },
        {
          name: "API budget creation",
          expectedInvalidations: 2,
          write: async () => {
            createdBudgetId = (
              await budgetsService.createBudget(targetUserId, {
                name: "Cache fixture budget",
                items: [
                  { categoryId: createdCategoryId!, amountCents: "1000" },
                ],
              })
            ).id;
          },
        },
        {
          name: "API budget item replacement",
          expectedInvalidations: 2,
          write: () =>
            budgetsService.replaceBudgetItems(targetUserId, createdBudgetId!, [
              { categoryId: createdCategoryId!, amountCents: 1100n },
            ]),
        },
        {
          name: "API budget item upsert",
          expectedInvalidations: 2,
          write: () =>
            budgetsService.upsertBudgetItem(
              targetUserId,
              createdCategoryId!,
              1200n,
            ),
        },
        {
          name: "API budget item deletion",
          expectedInvalidations: 2,
          write: () =>
            budgetsService.deleteBudgetItem(targetUserId, createdCategoryId!),
        },
        {
          name: "API rule creation",
          expectedInvalidations: 2,
          write: async () => {
            createdRuleId = (
              await rulesService.createRule(targetUserId, {
                matchType: "name_contains",
                matchNameContains: "Test",
                actionCategoryId: null,
                actionMarkReviewed: true,
                applyToExisting: false,
              })
            ).rule.id;
          },
        },
        {
          name: "API rule update",
          expectedInvalidations: 2,
          write: () =>
            rulesService.updateRule(targetUserId, createdRuleId!, {
              priority: 101,
            }),
        },
        {
          name: "worker retroactive rule application",
          expectedInvalidations: 2,
          write: () =>
            applyRuleRetroactively(createdRuleId!, targetUserId, {
              repository: rulesRepository,
              withUserMutation: mutate,
            }),
        },
        {
          name: "API rule deletion",
          expectedInvalidations: 2,
          write: () => rulesService.deleteRule(targetUserId, createdRuleId!),
        },
        {
          name: "API pipeline schedule update",
          expectedInvalidations: 2,
          write: () =>
            pipelineService.upsertSchedule(targetUserId, {
              hour: 3,
              minute: 15,
              timezone: "UTC",
              enabled: true,
            }),
        },
        {
          name: "worker net-worth snapshot",
          expectedInvalidations: 2,
          write: () => snapshotService.snapshot(targetUserId),
        },
        {
          name: "worker bill detection",
          expectedInvalidations: 2,
          write: () =>
            runBillDetection(targetUserId, {
              repository: billsRepository,
              cache,
              withUserMutation: mutate,
            }),
        },
        {
          name: "worker bill materialization",
          expectedInvalidations: 2,
          write: () =>
            materializeBillsForUser(targetUserId, createdBillId, 1, {
              repository: billsRepository,
              occurrences: billOccurrences,
              cache,
              withUserMutation: mutate,
              now: () => new Date("2026-09-15T00:00:00.000Z"),
            }),
        },
        {
          name: "worker overdue sweep",
          expectedInvalidations: 2,
          write: () =>
            runOverdueSweep(targetUserId, {
              occurrences: billOccurrences,
              cache,
              withUserMutation: mutate,
              workerLogger: { debug: () => undefined },
            }),
        },
        {
          name: "worker forecast-event resolution",
          expectedInvalidations: 2,
          write: () =>
            resolveMaturedForecastEvents(targetUserId, {
              repository: billsRepository,
              occurrences: billOccurrences,
              cache,
              withUserMutation: mutate,
            }),
        },
        {
          name: "worker statement-bill upsert",
          expectedInvalidations: 2,
          write: () =>
            upsertStatementBills(targetUserId, {
              db: harness.db,
              cache,
              withUserMutation: mutate,
            }),
        },
        {
          name: "API Plaid token exchange",
          expectedInvalidations: 2,
          write: async () => {
            exchangedItemId = (
              await plaidService.exchangePublicToken(targetUserId, {
                publicToken: "sandbox-public-token",
                institution: {
                  id: "sandbox-institution",
                  name: "Sandbox institution",
                },
              })
            ).itemId;
          },
        },
        {
          name: "API Plaid balance refresh",
          expectedInvalidations: 2,
          write: () =>
            plaidService.refreshItemBalances(targetUserId, targetItem.id),
        },
        {
          name: "worker Plaid transaction sync",
          expectedInvalidations: 2,
          write: () => plaidSyncService.syncItem(targetUserId, targetItem.id),
        },
        {
          name: "worker Plaid liabilities sync",
          expectedInvalidations: 2,
          write: () =>
            plaidLiabilitiesService.syncItemLiabilities(
              targetUserId,
              targetItem.id,
            ),
        },
        {
          name: "API category archive",
          expectedInvalidations: 2,
          write: () =>
            categoryService.archiveCategory(targetUserId, createdCategoryId!),
        },
        {
          name: "API bill deletion",
          expectedInvalidations: 2,
          write: () => billsService.deleteBill(targetUserId, createdBillId!),
        },
        {
          name: "worker item-error webhook",
          expectedInvalidations: 1,
          write: () =>
            workerHandler({
              provider: "plaid",
              providerItemId: targetItem.plaidItemId,
              webhookType: "ITEM",
              webhookCode: "ERROR",
              payload: { error: { error_code: "ITEM_LOGIN_REQUIRED" } },
            } as Parameters<typeof workerHandler>[0]),
        },
        {
          name: "worker item-pending-expiration webhook",
          expectedInvalidations: 1,
          write: () =>
            workerHandler({
              provider: "plaid",
              providerItemId: targetItem.plaidItemId,
              webhookType: "ITEM",
              webhookCode: "PENDING_EXPIRATION",
              payload: {},
            } as Parameters<typeof workerHandler>[0]),
        },
        {
          name: "worker item-login-repaired webhook",
          expectedInvalidations: 1,
          write: () =>
            workerHandler({
              provider: "plaid",
              providerItemId: targetItem.plaidItemId,
              webhookType: "ITEM",
              webhookCode: "LOGIN_REPAIRED",
              payload: {},
            } as Parameters<typeof workerHandler>[0]),
        },
        {
          name: "API Plaid item unlink",
          expectedInvalidations: 2,
          write: () => plaidService.unlinkItem(targetUserId, exchangedItemId!),
        },
        {
          name: "API account removal",
          expectedInvalidations: 2,
          write: () => accountService.removeAccount(targetUserId, account.id),
        },
        {
          name: "API user-data import",
          expectedInvalidations: 2,
          write: () =>
            userDataService.importUserData(targetUserId, importPayload),
        },
        {
          name: "API user-data reset",
          expectedInvalidations: 2,
          write: () => userDataService.resetUserData(targetUserId),
        },
      ] as const;

      for (const scenario of scenarios) {
        const beforeRevision = await getUserRevision(targetUserId, harness.db);
        const controlRevision = await getUserRevision(
          controlUserId,
          harness.db,
        );
        await primeEveryApplicableCacheFamily(
          cache,
          targetUserId,
          beforeRevision,
        );
        await primeEveryApplicableCacheFamily(
          cache,
          controlUserId,
          controlRevision,
        );
        expect(cache.stats().entries).toBe(cacheFamilies.length * 2);
        const invalidationsBeforeWrite = cache.stats().userInvalidations;

        await scenario.write();
        await waitFor(
          () =>
            cache.stats().userInvalidations >=
            invalidationsBeforeWrite + scenario.expectedInvalidations,
        );
        expect(cache.stats().entries).toBe(cacheFamilies.length);
        expect(await getUserRevision(targetUserId, harness.db)).toBeGreaterThan(
          beforeRevision,
        );
        expect(cache.stats().userEntriesInvalidated).toBeGreaterThanOrEqual(
          cacheFamilies.length,
        );

        let recomputes = 0;
        await cache.getOrCompute(
          {
            userId: targetUserId,
            method: "GET",
            route: "/accounts",
            query: {},
            revision: await getUserRevision(targetUserId, harness.db),
          },
          async () => ({ recompute: ++recomputes }),
        );
        expect(recomputes).toBe(1);
        expect(cache.stats().entries).toBe(cacheFamilies.length + 1);
        expect(
          await harness.db
            .select()
            .from(auditLog)
            .where(eq(auditLog.userId, targetUserId)),
        ).not.toEqual([]);
        expect(
          await harness.db
            .select()
            .from(accounts)
            .where(eq(accounts.userId, controlUserId)),
        ).toEqual([]);
      }
    } finally {
      await listener.stop();
      await harness.cleanup();
    }
  }, 120_000);
});
