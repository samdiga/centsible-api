import { describe, expect, it, vi } from "vitest";

vi.mock("../../platform/config/env.js", () => ({
  env: vi.fn(() => {
    throw new Error("configuration must not be parsed while composing the app");
  }),
}));

vi.mock("../../platform/database/client.js", () => ({
  getDb: vi.fn(() => {
    throw new Error("database must not be opened while composing the app");
  }),
}));

import { createHttpApp } from "../create-http-app.js";
import { env } from "../../platform/config/env.js";
import { getDb } from "../../platform/database/client.js";

describe("createHttpApp", () => {
  it("constructs a health-capable app without parsing configuration or opening the database", async () => {
    const app = createHttpApp();
    const response = await app.request("/health");

    expect(response.status).toBe(200);
    expect(env).not.toHaveBeenCalled();
    expect(getDb).not.toHaveBeenCalled();
  });

  it("creates no timers in the default composition shell", () => {
    vi.useFakeTimers();
    createHttpApp();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
