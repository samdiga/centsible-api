import type { Env } from "../config/env.js";
import { loadApnsConfig, type ApnsConfig } from "./apns-config.js";
import {
  createApnsTokenProvider,
  type ApnsTokenProvider,
} from "./apns-token-provider.js";
import {
  createHttp2ApnsTransport,
  type ApnsTransport,
} from "./apns-transport.js";

export type ApnsSendInput = Readonly<{
  deviceToken: string;
  payload: Record<string, unknown>;
  pushType?: string;
  priority?: 5 | 10;
  collapseId?: string;
  onInvalidToken?: () => Promise<void> | void;
}>;

export type ApnsSendResult =
  | Readonly<{ outcome: "disabled" }>
  | Readonly<{ outcome: "sent"; apnsId?: string }>
  | Readonly<{ outcome: "invalid-token"; status: number; reason: string }>
  | Readonly<{ outcome: "retryable"; status: number; reason?: string }>
  | Readonly<{ outcome: "error"; status: number; reason?: string }>;

export type ApnsSender = Readonly<{
  isEnabled: () => boolean;
  send: (input: ApnsSendInput) => Promise<ApnsSendResult>;
}>;

export type ApnsSenderDependencies = Readonly<{
  env?: Env;
  config?: ApnsConfig;
  transport?: ApnsTransport;
  tokenProvider?: ApnsTokenProvider;
  now?: () => number;
}>;

function hostFor(environment: ApnsConfig["environment"]): string {
  return environment === "production"
    ? "api.push.apple.com"
    : "api.sandbox.push.apple.com";
}

function isUnregisteredToken(
  status: number,
  reason: string | undefined,
): boolean {
  if (status === 410 && reason === "Unregistered") return true;
  if (status === 400 && reason === "BadDeviceToken") return true;
  return false;
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/** APNs push sender: disabled when config is missing, so the worker never crashes on it. */
export function createApnsSender(
  dependencies: ApnsSenderDependencies = {},
): ApnsSender {
  const config =
    dependencies.config ??
    (dependencies.env ? loadApnsConfig(dependencies.env) : undefined);
  const transport = dependencies.transport ?? createHttp2ApnsTransport();
  const now = dependencies.now ?? Date.now;
  const tokenProvider =
    dependencies.tokenProvider ??
    (config ? createApnsTokenProvider(config, now) : undefined);

  return {
    isEnabled: () => config !== undefined,

    async send(input) {
      if (!config || !tokenProvider) return { outcome: "disabled" };

      const token = await tokenProvider.getToken();
      const response = await transport.send({
        host: hostFor(config.environment),
        path: `/3/device/${input.deviceToken}`,
        authorization: `bearer ${token}`,
        topic: config.bundleId,
        pushType: input.pushType ?? "alert",
        priority: input.priority ?? 10,
        ...(input.collapseId ? { collapseId: input.collapseId } : {}),
        body: JSON.stringify(input.payload),
      });

      if (response.status === 200) {
        return {
          outcome: "sent",
          ...(response.apnsId ? { apnsId: response.apnsId } : {}),
        };
      }

      if (isUnregisteredToken(response.status, response.reason)) {
        await input.onInvalidToken?.();
        return {
          outcome: "invalid-token",
          status: response.status,
          reason: response.reason ?? "Unregistered",
        };
      }

      if (isRetryable(response.status)) {
        return {
          outcome: "retryable",
          status: response.status,
          ...(response.reason ? { reason: response.reason } : {}),
        };
      }

      return {
        outcome: "error",
        status: response.status,
        ...(response.reason ? { reason: response.reason } : {}),
      };
    },
  };
}
