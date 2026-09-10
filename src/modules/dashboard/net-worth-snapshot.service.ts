import { auditLogRepository } from "../../platform/database/audit-log.repository.js";
import { getDb, schema } from "../../platform/database/client.js";
import type { DbTransaction } from "../../platform/database/types.js";
import { createResponseCache } from "../../platform/cache/response-cache.js";
import {
  createWithUserMutation,
  type UserMutationService,
} from "../../platform/cache/user-revisions.repository.js";
import {
  dashboardRepository,
  type DashboardAccountRow,
} from "./dashboard.repository.js";
import { computeNetWorth } from "./net-worth.js";

type SnapshotInput = Readonly<{
  userId: string;
  date: string;
  totalAssets: bigint;
  totalLiabilities: bigint;
  netWorth: bigint;
  liquidAssets: bigint;
  breakdown: Record<string, number>;
}>;

type Dependencies = Readonly<{
  listAccounts?: (userId: string) => Promise<DashboardAccountRow[]>;
  upsert?: (input: SnapshotInput, tx: DbTransaction) => Promise<string>;
  audit?: typeof auditLogRepository.record;
  withUserMutation?: UserMutationService["withUserMutation"];
  now?: () => Date;
}>;

export type NetWorthSnapshotService = Readonly<{
  snapshot: (
    userId: string,
  ) => Promise<{ date: string; netWorthCents: string }>;
}>;

/** Writes one idempotent UTC-day snapshot and a bigint-safe audit record. */
export function createNetWorthSnapshotService(
  dependencies: Dependencies = {},
): NetWorthSnapshotService {
  const listAccounts =
    dependencies.listAccounts ?? dashboardRepository.listAccounts;
  const now = dependencies.now ?? (() => new Date());
  const upsert =
    dependencies.upsert ??
    (async (input: SnapshotInput, tx: DbTransaction) => {
      const rows = await tx
        .insert(schema.netWorthSnapshots)
        .values(input)
        .onConflictDoUpdate({
          target: [
            schema.netWorthSnapshots.userId,
            schema.netWorthSnapshots.date,
          ],
          set: {
            totalAssets: input.totalAssets,
            totalLiabilities: input.totalLiabilities,
            netWorth: input.netWorth,
            liquidAssets: input.liquidAssets,
            breakdown: input.breakdown,
          },
        })
        .returning({ id: schema.netWorthSnapshots.id });
      const row = rows[0];
      if (!row) throw new Error("Net-worth snapshot upsert returned no row");
      return row.id;
    });
  const audit = dependencies.audit ?? auditLogRepository.record;
  const mutate =
    dependencies.withUserMutation ??
    ((userId: string, callback: (tx: DbTransaction) => Promise<unknown>) =>
      createWithUserMutation({
        db: getDb(),
        cache: createResponseCache(),
      })(userId, callback));

  return {
    async snapshot(userId) {
      const accounts = await listAccounts(userId);
      const totals = computeNetWorth(accounts);
      const breakdown: Record<string, number> = {};
      for (const account of accounts) {
        if (account.excludeFromNetWorth || account.currentBalance === null)
          continue;
        const absolute =
          account.currentBalance < 0n
            ? -account.currentBalance
            : account.currentBalance;
        breakdown[account.type] =
          (breakdown[account.type] ?? 0) + Number(absolute);
      }
      const date = now().toISOString().slice(0, 10);
      const result = { date, netWorthCents: totals.netWorth.toString() };
      await mutate(userId, async (tx) => {
        const id = await upsert(
          {
            userId,
            date,
            totalAssets: totals.assets,
            totalLiabilities: totals.liabilities,
            netWorth: totals.netWorth,
            liquidAssets: totals.safeToSpend,
            breakdown,
          },
          tx,
        );
        await audit(
          {
            userId,
            entityType: "net_worth_snapshot",
            entityId: id,
            action: "create",
            source: "netWorth.snapshot",
            after: result,
          },
          tx,
        );
      });
      return result;
    },
  };
}
