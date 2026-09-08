import { z } from "zod";

export const PipelineStepSchema = z.object({
  step: z.string(),
  status: z.enum(["pending", "running", "success", "failed", "skipped"]),
  stats: z
    .record(z.string(), z.union([z.number(), z.string(), z.boolean()]))
    .nullable(),
  error: z.string().nullable(),
  startedAt: z.string().datetime({ offset: true }).nullable(),
  finishedAt: z.string().datetime({ offset: true }).nullable(),
});
export type PipelineStep = z.infer<typeof PipelineStepSchema>;

export const PipelineRunSchema = z.object({
  id: z.string().uuid(),
  trigger: z.enum(["scheduled", "manual", "webhook"]),
  status: z.enum(["running", "success", "partial", "failed"]),
  startedAt: z.string().datetime({ offset: true }),
  finishedAt: z.string().datetime({ offset: true }).nullable(),
  steps: z.array(PipelineStepSchema),
});
export type PipelineRun = z.infer<typeof PipelineRunSchema>;
export const PipelineRunsResponseSchema = z.object({
  runs: z.array(PipelineRunSchema),
});
export const PipelineRunDetailResponseSchema = z.object({
  run: PipelineRunSchema,
});
export const TriggerPipelineResponseSchema = z.object({
  runId: z.string().uuid().nullable(),
  deduped: z.boolean(),
});
export const PipelineRunsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().default(20),
});
export const SyncScheduleSchema = z.object({
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
  timezone: z.string().min(1),
  enabled: z.boolean(),
});
export type SyncSchedule = z.infer<typeof SyncScheduleSchema>;
export const SyncScheduleResponseSchema = z.object({
  schedule: SyncScheduleSchema,
});
export const UpdateSyncScheduleBodySchema = SyncScheduleSchema;
export type UpdateSyncScheduleBody = z.infer<
  typeof UpdateSyncScheduleBodySchema
>;
export const PipelineJobPayloadSchema = z.object({
  userId: z.string().uuid(),
  runId: z.string().uuid(),
});
export type PipelineJobPayload = z.infer<typeof PipelineJobPayloadSchema>;
