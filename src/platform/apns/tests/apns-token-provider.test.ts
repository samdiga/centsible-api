import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";
import { decodeProtectedHeader, decodeJwt } from "jose";

import type { ApnsConfig } from "../apns-config.js";
import { createApnsTokenProvider } from "../apns-token-provider.js";

function testConfig(): ApnsConfig {
  const { privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return {
    keyId: "test-key-id",
    teamId: "test-team-id",
    bundleId: "com.centsible.app",
    privateKey: privateKey as unknown as string,
    environment: "sandbox",
  };
}

describe("createApnsTokenProvider", () => {
  it("signs an ES256 JWT carrying the team id issuer and key id header", async () => {
    const provider = createApnsTokenProvider(testConfig(), () => 0);
    const token = await provider.getToken();

    const header = decodeProtectedHeader(token);
    const payload = decodeJwt(token);

    expect(header).toMatchObject({ alg: "ES256", kid: "test-key-id" });
    expect(payload.iss).toBe("test-team-id");
    expect(payload.iat).toBe(0);
  });

  it("reuses the cached token under the 60-minute Apple limit", async () => {
    let clock = 0;
    const provider = createApnsTokenProvider(testConfig(), () => clock);

    const first = await provider.getToken();
    clock += 30 * 60 * 1000;
    const second = await provider.getToken();

    expect(second).toBe(first);
  });

  it("mints a fresh token once the cache window elapses", async () => {
    let clock = 0;
    const provider = createApnsTokenProvider(testConfig(), () => clock);

    const first = await provider.getToken();
    clock += 46 * 60 * 1000;
    const second = await provider.getToken();

    expect(second).not.toBe(first);
    expect(decodeJwt(second).iat).toBe(46 * 60);
  });
});
