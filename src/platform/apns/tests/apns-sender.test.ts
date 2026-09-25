import { describe, expect, it, vi } from "vitest";

import type { ApnsConfig } from "../apns-config.js";
import { createApnsSender } from "../apns-sender.js";
import type {
  ApnsTransport,
  ApnsTransportResponse,
} from "../apns-transport.js";

const CONFIG: ApnsConfig = {
  keyId: "key-1",
  teamId: "team-1",
  bundleId: "com.centsible.app",
  privateKey: "unused-in-these-tests",
  environment: "sandbox",
};

function stubTransport(
  response: ApnsTransportResponse,
): ApnsTransport & { send: ReturnType<typeof vi.fn> } {
  return {
    send: vi.fn(async () => response),
    close: vi.fn(async () => {}),
  };
}

function stubTokenProvider(token = "stub-token") {
  return { getToken: vi.fn(async () => token), invalidate: vi.fn() };
}

describe("createApnsSender", () => {
  it("reports itself disabled when config is missing, without throwing", async () => {
    const sender = createApnsSender({});

    expect(sender.isEnabled()).toBe(false);
    await expect(
      sender.send({ deviceToken: "abc", payload: { aps: {} } }),
    ).resolves.toEqual({ outcome: "disabled" });
  });

  it("sends over the injected transport using the bundle id as topic", async () => {
    const transport = stubTransport({ status: 200, apnsId: "apns-id-1" });
    const tokenProvider = stubTokenProvider("signed-jwt");
    const sender = createApnsSender({
      config: CONFIG,
      transport,
      tokenProvider,
    });

    const result = await sender.send({
      deviceToken: "device-token",
      payload: { aps: { alert: "hi" } },
    });

    expect(result).toEqual({ outcome: "sent", apnsId: "apns-id-1" });
    expect(transport.send).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "api.sandbox.push.apple.com",
        path: "/3/device/device-token",
        authorization: "bearer signed-jwt",
        topic: "com.centsible.app",
        pushType: "alert",
        priority: 10,
        body: JSON.stringify({ aps: { alert: "hi" } }),
      }),
    );
  });

  it("uses the production host when configured for production", async () => {
    const transport = stubTransport({ status: 200 });
    const sender = createApnsSender({
      config: { ...CONFIG, environment: "production" },
      transport,
      tokenProvider: stubTokenProvider(),
    });

    await sender.send({ deviceToken: "device-token", payload: {} });

    expect(transport.send).toHaveBeenCalledWith(
      expect.objectContaining({ host: "api.push.apple.com" }),
    );
  });

  it.each([
    [410, "Unregistered"],
    [400, "BadDeviceToken"],
  ])(
    "maps %i/%s to invalid-token and clears the stored push token",
    async (status, reason) => {
      const transport = stubTransport({ status, reason });
      const onInvalidToken = vi.fn(async () => {});
      const sender = createApnsSender({
        config: CONFIG,
        transport,
        tokenProvider: stubTokenProvider(),
      });

      const result = await sender.send({
        deviceToken: "device-token",
        payload: {},
        onInvalidToken,
      });

      expect(result).toEqual({ outcome: "invalid-token", status, reason });
      expect(onInvalidToken).toHaveBeenCalledTimes(1);
    },
  );

  it.each([429, 500, 503])(
    "treats status %i as retryable without clearing the push token",
    async (status) => {
      const transport = stubTransport({ status, reason: "ServiceUnavailable" });
      const onInvalidToken = vi.fn(async () => {});
      const sender = createApnsSender({
        config: CONFIG,
        transport,
        tokenProvider: stubTokenProvider(),
      });

      const result = await sender.send({
        deviceToken: "device-token",
        payload: {},
        onInvalidToken,
      });

      expect(result).toEqual({
        outcome: "retryable",
        status,
        reason: "ServiceUnavailable",
      });
      expect(onInvalidToken).not.toHaveBeenCalled();
    },
  );

  it("treats other 4xx failures as a non-retryable error", async () => {
    const transport = stubTransport({ status: 403, reason: "BadCertificate" });
    const onInvalidToken = vi.fn(async () => {});
    const sender = createApnsSender({
      config: CONFIG,
      transport,
      tokenProvider: stubTokenProvider(),
    });

    const result = await sender.send({
      deviceToken: "device-token",
      payload: {},
      onInvalidToken,
    });

    expect(result).toEqual({
      outcome: "error",
      status: 403,
      reason: "BadCertificate",
    });
    expect(onInvalidToken).not.toHaveBeenCalled();
  });

  it("does not treat a 410 with a different reason as invalid-token", async () => {
    const transport = stubTransport({ status: 410, reason: "SomethingElse" });
    const sender = createApnsSender({
      config: CONFIG,
      transport,
      tokenProvider: stubTokenProvider(),
    });

    const result = await sender.send({
      deviceToken: "device-token",
      payload: {},
    });

    expect(result).toEqual({
      outcome: "error",
      status: 410,
      reason: "SomethingElse",
    });
  });
});

describe("provider token rejection", () => {
  it("drops the cached token and reports retryable on 403 ExpiredProviderToken", async () => {
    const tokenProvider = {
      getToken: vi.fn(async () => "old"),
      invalidate: vi.fn(),
    };
    const sender = createApnsSender({
      config: {
        keyId: "K",
        teamId: "T",
        bundleId: "com.example.app",
        privateKey: "unused",
        environment: "sandbox",
      },
      transport: {
        send: vi.fn(async () => ({
          status: 403,
          reason: "ExpiredProviderToken",
        })),
        close: vi.fn(async () => {}),
      },
      tokenProvider,
    });
    await expect(
      sender.send({ deviceToken: "abc", payload: {} }),
    ).resolves.toEqual({
      outcome: "retryable",
      status: 403,
      reason: "ExpiredProviderToken",
    });
    expect(tokenProvider.invalidate).toHaveBeenCalledTimes(1);
  });
});
