/**
 * One-off backfill: gives existing uncategorised transactions the category
 * the sync would give them today (the user's own choice for the same
 * merchant, else the bank's category mapped onto their categories). Never
 * touches a category the user or a rule set.
 *
 * Dry run by default (read-only): prints what would change, per category.
 * `--apply` writes, per user, through the normal mutation protocol (revision
 * bump + cache invalidation), and saves the changed ids to `--undo-file` so
 * the run can be reversed by setting those rows' category back to null.
 *
 *   PLAID_ACTIVE_ENV=production tsx --env-file=.env scripts/backfill-categories.ts
 *   PLAID_ACTIVE_ENV=production tsx --env-file=.env scripts/backfill-categories.ts --apply --undo-file=/path/undo.json
 */
import { writeFile } from "node:fs/promises";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";

import { loadEnv } from "../src/platform/config/env.js";
import { createResponseCache } from "../src/platform/cache/response-cache.js";
import { createWithUserMutation } from "../src/platform/cache/user-revisions.repository.js";
import { closeDb, getDb, schema } from "../src/platform/database/client.js";
import type { Db, DbTransaction } from "../src/platform/database/types.js";
import {
  autoCategorize,
  planAutoCategories,
  type UncategorisedTransaction,
} from "../src/modules/transactions/auto-categorize.js";

const uncategorised = (
  db: Db | DbTransaction,
  userId: string,
): Promise<UncategorisedTransaction[]> =>
  db
    .select({
      id: schema.transactions.id,
      merchantName: schema.transactions.merchantName,
      name: schema.transactions.name,
      plaidCategoryPrimary: schema.transactions.plaidCategoryPrimary,
      plaidCategoryDetailed: schema.transactions.plaidCategoryDetailed,
    })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.userId, userId),
        isNull(schema.transactions.deletedAt),
        isNull(schema.transactions.categoryId),
        eq(schema.transactions.userCategoryOverride, false),
      ),
    );

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const undoFile = process.argv
    .find((arg) => arg.startsWith("--undo-file="))
    ?.slice("--undo-file=".length);
  if (apply && !undoFile)
    throw new Error("--apply needs --undo-file=<path> to record what changed");

  const environment = loadEnv();
  const db = getDb();
  console.log(
    `${apply ? "APPLY" : "DRY RUN"} against ${environment.PLAID_ACTIVE_ENV}`,
  );

  const users = await db
    .selectDistinct({ userId: schema.transactions.userId })
    .from(schema.transactions)
    .where(
      and(
        isNull(schema.transactions.deletedAt),
        isNull(schema.transactions.categoryId),
        eq(schema.transactions.userCategoryOverride, false),
      ),
    );

  const names = new Map(
    (
      await db
        .select({
          id: schema.categories.id,
          name: schema.categories.name,
          parentId: schema.categories.parentId,
        })
        .from(schema.categories)
    ).map((row) => [row.id, row]),
  );
  const label = (categoryId: string) => {
    const category = names.get(categoryId);
    const parent = category?.parentId ? names.get(category.parentId) : null;
    return parent
      ? `${parent.name} / ${category!.name}`
      : (category?.name ?? categoryId);
  };

  const undo: Record<string, string[]> = {};
  for (const { userId } of users) {
    const rows = await uncategorised(db, userId);
    const plan = await planAutoCategories(userId, rows, db);
    const byCategory = new Map<string, { history: number; bank: number }>();
    for (const item of plan) {
      const entry = byCategory.get(item.categoryId) ?? { history: 0, bank: 0 };
      entry[item.source] += 1;
      byCategory.set(item.categoryId, entry);
    }
    console.log(
      `\nuser ${userId}: ${rows.length} uncategorised, ${plan.length} would be categorised, ${rows.length - plan.length} stay uncategorised`,
    );
    for (const [categoryId, counts] of [...byCategory].sort(
      (a, b) => b[1].history + b[1].bank - (a[1].history + a[1].bank),
    ))
      console.log(
        `  ${String(counts.history + counts.bank).padStart(4)}  ${label(categoryId)}${counts.history ? `  (${counts.history} from your earlier choices)` : ""}`,
      );

    if (!apply || plan.length === 0) continue;
    const planned = new Set(plan.map((item) => item.transactionId));
    const withUserMutation = createWithUserMutation({
      db,
      cache: createResponseCache(),
    });
    const result = await withUserMutation(userId, async (tx) => {
      const counts = await autoCategorize(userId, rows, tx);
      // Rows this run changed: planned ones that now carry a category.
      const changed = await tx
        .select({ id: schema.transactions.id })
        .from(schema.transactions)
        .where(
          and(
            eq(schema.transactions.userId, userId),
            inArray(schema.transactions.id, [...planned]),
            isNotNull(schema.transactions.categoryId),
            // A category the user picked meanwhile isn't ours to undo.
            eq(schema.transactions.userCategoryOverride, false),
          ),
        );
      return { counts, changed: changed.map((row) => row.id) };
    });
    undo[userId] = result.changed;
    console.log(
      `  applied: ${result.counts.fromHistory} from earlier choices, ${result.counts.fromBank} from the bank's category`,
    );
  }
  if (apply && undoFile) {
    await writeFile(undoFile, JSON.stringify(undo, null, 2));
    console.log(`\nUndo list written to ${undoFile}`);
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
