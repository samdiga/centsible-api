import { AppError } from "../../platform/errors/app-error.js";
import { normalizeErrorCode } from "../../platform/jobs/jobs.types.js";
import { logger as defaultLogger } from "../../platform/logging/logger.js";
import { PlaidServiceError } from "./plaid.errors.js";
import {
  createInboundEventsRepository,
  INBOUND_EVENT_LEASE_MS,
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
  | "heartbeatInboundEvent"
  | "releaseInboundEvent"
  | "hasProcessedDuplicate"
>;

type Options = Readonly<{
  workerId: string;
  repository?: Repository;
  handler?: (
    event: ClaimedInboundWebhookEvent,
    context: Readonly<{ signal: AbortSignal }>,
  ) => Promise<unknown>;
  pollMs?: number;
  concurrency?: number;
  leaseMs?: number;
  heartbeatMs?: number;
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
  const leaseMs = options.leaseMs ?? INBOUND_EVENT_LEASE_MS;
  const heartbeatMs = options.heartbeatMs ?? Math.floor(leaseMs / 2);
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 30_000;
  if (!Number.isInteger(pollMs) || pollMs <= 0)
    throw new RangeError("pollMs must be a positive integer");
  if (!Number.isInteger(concurrency) || concurrency <= 0)
    throw new RangeError("concurrency must be a positive integer");
  if (!Number.isInteger(leaseMs) || leaseMs <= 0)
    throw new RangeError("leaseMs must be a positive integer");
  if (!Number.isInteger(heartbeatMs) || heartbeatMs <= 0)
    throw new RangeError("heartbeatMs must be a positive integer");
  if (heartbeatMs >= leaseMs)
    throw new RangeError("heartbeatMs must be less than leaseMs");
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
  type ActiveEvent = {
    controller: AbortController;
    stopHeartbeat: () => void;
  };
  const active = new Map<string, ActiveEvent>();

  const releaseUnstartedClaim = async (
    event: ClaimedInboundWebhookEvent,
  ): Promise<void> => {
    try {
      const released = await repository.releaseInboundEvent(
        event.id,
        options.workerId,
        event.attempts,
        event.leaseToken,
      );
      if (!released)
        log.error({ eventId: event.id }, "inbound event release lost lease");
    } catch (error: unknown) {
      log.error({ eventId: event.id, error }, "inbound event release failed");
    }
  };

  const runEvent = async (event: ClaimedInboundWebhookEvent): Promise<void> => {
    const controller = new AbortController();
    const activeEvent: ActiveEvent = {
      controller,
      stopHeartbeat: () => undefined,
    };
    active.set(event.id, activeEvent);
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let heartbeatPromise: Promise<void> | undefined;
    let lostLease = false;
    const markLeaseLost = (reason: unknown): void => {
      if (lostLease) return;
      lostLease = true;
      activeEvent.stopHeartbeat();
      controller.abort(reason);
    };
    activeEvent.stopHeartbeat = () => {
      if (heartbeatTimer !== undefined) {
        unschedule(heartbeatTimer);
        heartbeatTimer = undefined;
      }
    };
    heartbeatTimer = schedule(() => {
      if (heartbeatPromise) return;
      heartbeatPromise = repository
        .heartbeatInboundEvent(
          event.id,
          options.workerId,
          event.attempts,
          event.leaseToken,
          leaseMs,
        )
        .then((owned) => {
          if (!owned) markLeaseLost(new Error("inbound event lease lost"));
        })
        .catch((error: unknown) => {
          markLeaseLost(error);
          log.error(
            { eventId: event.id, error },
            "inbound event heartbeat failed",
          );
        })
        .finally(() => {
          heartbeatPromise = undefined;
        });
    }, heartbeatMs);
    try {
      if (!(await repository.hasProcessedDuplicate(event.id, event.dedupeKey)))
        await handler(event, { signal: controller.signal });
      if (lostLease || stopping) return;
      const owned = await repository.markProcessed(
        event.id,
        options.workerId,
        event.attempts,
        event.leaseToken,
      );
      if (!owned)
        log.error(
          { eventId: event.id },
          "inbound event terminal update lost lease",
        );
    } catch (error) {
      if (lostLease || stopping) return;
      const code = safeErrorCode(error);
      let owned: boolean;
      if (terminalError(error) || event.attempts >= INBOUND_EVENT_MAX_ATTEMPTS)
        owned = await repository.markDead(
          event.id,
          options.workerId,
          event.attempts,
          event.leaseToken,
          code,
        );
      else
        owned = await repository.scheduleRetry(
          event.id,
          options.workerId,
          event.attempts,
          event.leaseToken,
          code,
          now(),
          random,
        );
      if (!owned)
        log.error(
          { eventId: event.id },
          "inbound event terminal update lost lease",
        );
      log.error({ eventId: event.id, code }, "inbound event handling failed");
    } finally {
      activeEvent.stopHeartbeat();
      active.delete(event.id);
    }
  };

  const pollOnce = (): Promise<void> => {
    if (inFlight) return inFlight;
    if (stopping) return Promise.resolve();
    inFlight = (async () => {
      const claimed = await repository.claimInboundEvents(
        options.workerId,
        concurrency,
        leaseMs,
      );
      if (stopping) {
        await Promise.allSettled(claimed.map(releaseUnstartedClaim));
        return;
      }
      const itemQueues = new Map<string, Promise<void>>();
      await Promise.all(
        claimed.map((event) => {
          const key = event.providerItemId
            ? `${event.provider}:${event.providerItemId}`
            : event.id;
          const previous = itemQueues.get(key) ?? Promise.resolve();
          const work = previous
            .catch(() => undefined)
            .then(() =>
              stopping ? releaseUnstartedClaim(event) : runEvent(event),
            );
          itemQueues.set(key, work);
          return work;
        }),
      );
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
      for (const event of active.values()) {
        event.stopHeartbeat();
        event.controller.abort(new Error("worker stopping"));
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
