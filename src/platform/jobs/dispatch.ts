import type { EnqueueJobInput, Job } from "./jobs.types.js";
import type { DbTransaction } from "../database/types.js";

export type JobDispatcher = (
  input: EnqueueJobInput,
) => Promise<{ job: Job; deduped: boolean }>;
export type BillJobDispatcher = Readonly<{
  detect: (userId: string) => Promise<void>;
  materialize: (userId: string, billId: string) => Promise<void>;
}>;
export type RuleJobDispatcher = Readonly<{
  dispatchRetroactive: (
    ruleId: string,
    userId: string,
  ) => Promise<{ id: string }>;
}>;

/** Narrow enqueue port for work that must join a caller-owned transaction. */
export type JobEnqueuer = (
  input: EnqueueJobInput,
  tx: DbTransaction,
) => Promise<{ job: Pick<Job, "id">; deduped: boolean }>;

export function createBillJobDispatcher(
  enqueue: JobDispatcher,
): BillJobDispatcher {
  return {
    async detect(userId) {
      await enqueue({ type: "recurring_detect", payload: { userId }, userId });
    },
    async materialize(userId, billId) {
      await enqueue({
        type: "materialize_recurring",
        payload: { userId, seriesId: billId },
        userId,
      });
    },
  };
}

export function createRuleJobDispatcher(
  enqueue: JobDispatcher,
): RuleJobDispatcher {
  return {
    async dispatchRetroactive(ruleId, userId) {
      const result = await enqueue({
        type: "rule_retroactive_apply",
        payload: { ruleId, userId },
        userId,
      });
      return { id: result.job.id };
    },
  };
}
