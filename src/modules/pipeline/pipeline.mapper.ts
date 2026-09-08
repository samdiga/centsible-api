import type {
  PipelineRunRow,
  PipelineRunStepRow,
} from "./pipeline.repository.js";
import type { PipelineRun, PipelineStep } from "./pipeline.schemas.js";

export function toPipelineStepDto(step: PipelineRunStepRow): PipelineStep {
  return {
    step: step.step,
    status: step.status,
    stats: step.stats ?? null,
    error: step.error ?? null,
    startedAt: step.startedAt?.toISOString() ?? null,
    finishedAt: step.finishedAt?.toISOString() ?? null,
  };
}

export function toPipelineRunDto(
  run: PipelineRunRow & { steps: PipelineRunStepRow[] },
): PipelineRun {
  return {
    id: run.id,
    trigger: run.trigger,
    status: run.status,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    steps: run.steps.map(toPipelineStepDto),
  };
}
