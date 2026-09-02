import { describe, expect, it, vi } from "vitest";

const serve = vi.fn();
const installGracefulShutdown = vi.fn();

vi.mock("@hono/node-server", () => ({ serve }));
vi.mock("../platform/http/shutdown.js", () => ({ installGracefulShutdown }));

describe("entrypoint imports", () => {
  it("do not start a server or install lifecycle handlers", async () => {
    await import("./api.js");
    await import("./worker.js");

    expect(serve).not.toHaveBeenCalled();
    expect(installGracefulShutdown).not.toHaveBeenCalled();
  });
});
