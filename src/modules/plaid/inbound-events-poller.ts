import { AppError } from "../../platform/errors/app-error.js";
import { normalizeErrorCode } from "../../platform/jobs/jobs.types.js";
import { logger as defaultLogger } from "../../platform/logging/logger.js";
import { PlaidServiceError } from "./plaid.errors.js";
import {
  createInboundEventsRepository,
  INBOUND_EVENT_MAX_ATTEMPTS,
  type InboundEventsRepository,
} from "./inbound-events.repository.js";
import { createInboundEventHandler } from "./inbound-event-handler.js";
import type { ClaimedInboundWebhookEvent } from "./inbound-events.types.js";

type Repository = Pick<
  InboundEventsRepository,
  | "claimInboundEvents"
  | "markProcessed"
  | "scheduleRetry"
  | "markDead"
  | "hasProcessedDuplicate"
>;

type Options = Readonly<{
  workerId: string;
  repository?: Repository;
  handler?: (event: ClaimedInboundWebhookEvent) => Promise<unknown>;
  pollMs?: number;
  concurrency?: number;
  leaseMs?: number;
  now?: () => Date;
  random?: () => number;
  shutdownTimeoutMs?: number;
  logger?: Pick<typeof defaultLogger, "error">;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}>;

function safeErrorCode(error: unknown): string {
  if (error instanceof AppError) return normalizeErrorCode(error.code);
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return normalizeErrorCode(code);
  }
  return "WEBHOOK_HANDLER_FAILURE";
}

function terminalError(error: unknown): boolean {
  return (
    (error instanceof PlaidServiceError && error.isTerminal) ||
    (error instanceof AppError &&
      error.httpStatus >= 400 &&
      error.httpStatus < 500)
  );
}

/** Leases verified webhook deliveries and advances each row to a terminal or retry state. */
export function createInboundEventsPoller(options: Options): Readonly<{
  start: () => void;
  stop: () => Promise<void>;
  pollOnce: () => Promise<void>;
}> {
  if (!options.workerId.trim()) throw new RangeError("workerId is required");
  const pollMs = options.pollMs ?? 15_000;
  const concurrency = Math.min(options.concurrency ?? 5, 100);
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 30_000;
  if (!Number.isInteger(pollMs) || pollMs <= 0)
    throw new RangeError("pollMs must be a positive integer");
  if (!Number.isInteger(concurrency) || concurrency <= 0)
    throw new RangeError("concurrency must be a positive integer");
  if (!Number.isInteger(shutdownTimeoutMs) || shutdownTimeoutMs <= 0)
    throw new RangeError("shutdownTimeoutMs must be a positive integer");
  const repository = options.repository ?? createInboundEventsRepository();
  const handler = options.handler ?? createInboundEventHandler();
  const now = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;
  const log = options.logger ?? defaultLogger;
  const schedule = options.setIntervalFn ?? setInterval;
  const unschedule = options.clearIntervalFn ?? clearInterval;
  const scheduleTimeout = options.setTimeoutFn ?? setTimeout;
  const unscheduleTimeout = options.clearTimeoutFn ?? clearTimeout;
  let stopping = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | undefined;

  const runEvent = async (event: ClaimedInboundWebhookEvent): Promise<void> => {
    try {
      if (!(await repository.hasProcessedDuplicate(event.id, event.dedupeKey)))
        await handler(event);
      await repository.markProcessed(event.id, options.workerId);
    } catch (error) {
      const code = safeErrorCode(error);
      if (terminalError(error) || event.attempts >= INBOUND_EVENT_MAX_ATTEMPTS)
        await repository.markDead(event.id, options.workerId, code);
      else
        await repository.scheduleRetry(
          event.id,
          options.workerId,
          event.attempts,
          code,
          now(),
          random,
        );
      log.error({ eventId: event.id, code }, "inbound event handling failed");
    }
  };

  const pollOnce = (): Promise<void> => {
    if (inFlight) return inFlight;
    if (stopping) return Promise.resolve();
    inFlight = (async () => {
      const claimed = await repository.claimInboundEvents(
        options.workerId,
        concurrency,
        options.leaseMs,
      );
      await Promise.all(claimed.map(runEvent));
    })()
      .catch((error: unknown) => {
        log.error({ error }, "inbound event claim failed");
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };

  return {
    start() {
      if (timer || stopping) return;
      void pollOnce();
      timer = schedule(() => void pollOnce(), pollMs);
    },
    async stop() {
      stopping = true;
      if (timer) {
        unschedule(timer);
        timer = undefined;
      }
      if (!inFlight) return;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          inFlight,
          new Promise<void>((resolve) => {
            timeout = scheduleTimeout(resolve, shutdownTimeoutMs);
          }),
        ]);
      } finally {
        if (timeout) unscheduleTimeout(timeout);
      }
    },
    pollOnce,
  };
}
