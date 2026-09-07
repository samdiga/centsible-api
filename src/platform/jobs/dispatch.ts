import type { EnqueueJobInput, Job } from "./jobs.types.js";

export type JobDispatcher = (
  input: EnqueueJobInput,
) => Promise<{ job: Job; deduped: boolean }>;
export type BillJobDispatcher = JobDispatcher;
export type RuleJobDispatcher = JobDispatcher;
