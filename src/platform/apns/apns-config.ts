import type { Env } from "../config/env.js";

export type ApnsConfig = Readonly<{
  keyId: string;
  teamId: string;
  bundleId: string;
  privateKey: string;
  environment: "sandbox" | "production";
}>;

function normalizePrivateKey(raw: string): string {
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

/** Builds APNs config from process env, or undefined when any key is missing. */
export function loadApnsConfig(env: Env): ApnsConfig | undefined {
  const {
    APNS_KEY_ID,
    APNS_TEAM_ID,
    APNS_BUNDLE_ID,
    APNS_PRIVATE_KEY,
    APNS_ENV,
  } = env;
  if (!APNS_KEY_ID || !APNS_TEAM_ID || !APNS_BUNDLE_ID || !APNS_PRIVATE_KEY) {
    return undefined;
  }
  return {
    keyId: APNS_KEY_ID,
    teamId: APNS_TEAM_ID,
    bundleId: APNS_BUNDLE_ID,
    privateKey: normalizePrivateKey(APNS_PRIVATE_KEY),
    environment: APNS_ENV,
  };
}
