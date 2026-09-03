import { describe, expect, it, vi } from "vitest";

const serve = vi.fn();
const installGracefulShutdown = vi.fn();

vi.mock("@hono/node-server", () => ({ serve }));
vi.mock("../../platform/http/shutdown.js", () => ({ installGracefulShutdown }));

describe("entrypoint imports", () => {
  it("does not start a server or install lifecycle handlers", async () => {
    await import("../api.js");
    await import("../worker.js");
    await import("../../../entrypoints/api.js");
    await import("../../../entrypoints/worker.js");

    expect(serve).not.toHaveBeenCalled();
    expect(installGracefulShutdown).not.toHaveBeenCalled();
  });
});
