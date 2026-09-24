import { importPKCS8, SignJWT, type CryptoKey } from "jose";

import type { ApnsConfig } from "./apns-config.js";

const TOKEN_MAX_AGE_MS = 45 * 60 * 1000;

export type ApnsTokenProvider = Readonly<{
  getToken: () => Promise<string>;
}>;

/** Signs and caches an ES256 APNs provider JWT, refreshing well under Apple's 60-minute limit. */
export function createApnsTokenProvider(
  config: ApnsConfig,
  now: () => number = Date.now,
): ApnsTokenProvider {
  let cached: Readonly<{ token: string; issuedAt: number }> | undefined;
  let signingKey: Promise<CryptoKey> | undefined;

  const importKey = (): Promise<CryptoKey> => {
    signingKey ??= importPKCS8(config.privateKey, "ES256");
    return signingKey;
  };

  return {
    async getToken() {
      const currentTime = now();
      if (cached && currentTime - cached.issuedAt < TOKEN_MAX_AGE_MS) {
        return cached.token;
      }

      const key = await importKey();
      const token = await new SignJWT({})
        .setProtectedHeader({ alg: "ES256", kid: config.keyId })
        .setIssuer(config.teamId)
        .setIssuedAt(Math.floor(currentTime / 1000))
        .sign(key);

      cached = { token, issuedAt: currentTime };
      return token;
    },
  };
}
