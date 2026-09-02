import { describe, expect, it, vi } from "vitest";
import { logger } from "../logging/logger.js";
import { installGracefulShutdown } from "./shutdown.js";

describe("installGracefulShutdown", () => {
  it("closes once for repeated signals and unregisters handlers", async () => {
    const close = vi.fn(async () => undefined);
    const unregister = installGracefulShutdown(close);

    process.emit("SIGTERM");
    process.emit("SIGINT");
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));

    unregister();
    process.emit("SIGTERM");
    await new Promise((resolve) => setImmediate(resolve));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("reports a close failure without throwing from the signal handler", async () => {
    const error = new Error("database token secret");
    const close = vi.fn(async () => {
      throw error;
    });
    const report = vi.spyOn(logger, "error").mockImplementation(() => logger);
    const unregister = installGracefulShutdown(close);

    process.emit("SIGTERM");
    await vi.waitFor(() => expect(report).toHaveBeenCalled());
    expect(report.mock.calls.flat().join(" ")).not.toContain(
      "database token secret",
    );

    unregister();
    report.mockRestore();
  });
});
