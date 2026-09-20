import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkerWakeClient,
  createWorkerWakeServer,
  type WorkerWakeServer,
} from "../worker-wake.js";

const activeServers: WorkerWakeServer[] = [];

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.stop()));
});

describe("worker wake transport", () => {
  it("accepts only POST at the configured loopback path without awaiting the sweep", async () => {
    let finishWake!: () => void;
    const wake = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishWake = resolve;
        }),
    );
    const server = createWorkerWakeServer({
      url: "http://127.0.0.1:0/internal/wake",
      wake,
      logger: { error: vi.fn() },
    });
    activeServers.push(server);
    const address = await server.start();

    const accepted = await fetch(address, { method: "POST" });
    const rejectedMethod = await fetch(address, { method: "GET" });
    const rejectedPath = await fetch(
      address.replace("/internal/wake", "/other"),
      { method: "POST" },
    );

    expect(accepted.status).toBe(202);
    expect(rejectedMethod.status).toBe(405);
    expect(rejectedPath.status).toBe(404);
    expect(wake).toHaveBeenCalledOnce();
    finishWake();
  });

  it("starts and stops idempotently", async () => {
    const server = createWorkerWakeServer({
      url: "http://127.0.0.1:0/wake",
      wake: async () => undefined,
      logger: { error: vi.fn() },
    });
    activeServers.push(server);

    const first = await server.start();
    const second = await server.start();
    await server.stop();
    await server.stop();

    expect(second).toBe(first);
    await expect(fetch(first, { method: "POST" })).rejects.toThrow();
  });

  it("client sends POST and rejects non-202 responses", async () => {
    const requests: string[] = [];
    const rawServer = createServer((request, response) => {
      requests.push(request.method ?? "");
      response.statusCode = requests.length === 1 ? 202 : 503;
      response.end();
    });
    await new Promise<void>((resolve) =>
      rawServer.listen(0, "127.0.0.1", resolve),
    );
    const address = rawServer.address();
    if (!address || typeof address === "string")
      throw new Error("test server did not bind TCP");
    const url = `http://127.0.0.1:${address.port}/wake`;
    const client = createWorkerWakeClient(url, { timeoutMs: 1_000 });

    await expect(client()).resolves.toBeUndefined();
    await expect(client()).rejects.toThrow("503");
    expect(requests).toEqual(["POST", "POST"]);
    await new Promise<void>((resolve, reject) =>
      rawServer.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("client aborts a stalled wake request at its timeout", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const client = createWorkerWakeClient("http://127.0.0.1:4011/wake", {
      timeoutMs: 50,
      fetchFn,
    });

    const rejection = expect(client()).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(50);

    await rejection;
    expect(fetchFn).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
