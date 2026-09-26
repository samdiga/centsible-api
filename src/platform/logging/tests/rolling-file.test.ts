import {
  mkdtempSync,
  mkdirSync,
  statSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRollingFileDestination } from "../rolling-file.js";

const directories: string[] = [];
function temporaryFile() {
  const directory = mkdtempSync(join(tmpdir(), "centsible-log-"));
  directories.push(directory);
  return join(directory, "combined.log");
}
async function write(
  file: string,
  lines: string[],
  maxBytes = 1000,
  retain = 7,
  now = () => new Date(),
) {
  const destination = createRollingFileDestination({
    file,
    maxBytes,
    retain,
    now,
  });
  for (const line of lines) destination.write(`${line}\n`);
  await new Promise<void>((resolve) => destination.end(resolve));
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
describe("combined rolling file", () => {
  it("keeps all entries from separate API and worker processes through competing rotations", async () => {
    const file = temporaryFile();
    const moduleUrl = new URL("../rolling-file.ts", import.meta.url).href;
    const run = (source: string) =>
      new Promise<void>((resolve, reject) => {
        const code = `import {createRollingFileDestination} from ${JSON.stringify(moduleUrl)}; const destination=createRollingFileDestination({file:${JSON.stringify(file)},maxBytes:1000,retain:64}); for(let i=0;i<400;i++)destination.write(JSON.stringify({source:${JSON.stringify(source)},i})+"\\n"); await new Promise(resolve=>destination.end(resolve));`;
        const child = spawn(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "-e", code],
          {
            env: { ...process.env, NODE_OPTIONS: "" },
            stdio: ["ignore", "ignore", "pipe"],
          },
        );
        let stderr = "";
        child.stderr.on("data", (data) => {
          stderr += String(data);
        });
        child.on("error", reject);
        child.on("exit", (code) =>
          code === 0 && !stderr
            ? resolve()
            : reject(new Error(`Log writer failed: ${stderr}`)),
        );
      });
    await Promise.all([run("api"), run("worker")]);
    const lines = readdirSync(join(file, ".."))
      .filter((name) => /^combined\.log(?:\.\d+)?$/.test(name))
      .flatMap((name) =>
        readFileSync(join(file, "..", name), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { source: string; i: number }),
      );
    expect(lines).toHaveLength(800);
    expect(new Set(lines.map((line) => `${line.source}:${line.i}`)).size).toBe(
      800,
    );
  });
  it("falls back without stopping the process when the destination cannot be written", async () => {
    const file = temporaryFile();
    await write(file, ["occupied"]);
    const failures: string[] = [];
    const destination = createRollingFileDestination({
      file: join(file, "impossible.log"),
      fallback: (chunk) => failures.push(chunk.toString()),
    });
    destination.write('{"msg":"[REDACTED]"}\n');
    await new Promise<void>((resolve) => destination.end(resolve));
    expect(failures).toEqual(['{"msg":"[REDACTED]"}\n']);
  });

  it("serializes competing writers and keeps complete JSON entries across size rotation", async () => {
    const file = temporaryFile();
    await Promise.all([
      write(
        file,
        Array.from({ length: 100 }, (_, i) =>
          JSON.stringify({ source: "api", i }),
        ),
        500,
        32,
      ),
      write(
        file,
        Array.from({ length: 100 }, (_, i) =>
          JSON.stringify({ source: "worker", i }),
        ),
        500,
        32,
      ),
    ]);
    const lines = readdirSync(join(file, ".."))
      .filter((name) => /^combined\.log(?:\.\d+)?$/.test(name))
      .flatMap((name) =>
        readFileSync(join(file, "..", name), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { source: string; i: number }),
      );
    expect(lines).toHaveLength(200);
    expect(new Set(lines.map((line) => `${line.source}:${line.i}`)).size).toBe(
      200,
    );
  });
  it("recovers a stale abandoned lock and creates private files", async () => {
    const file = temporaryFile();
    mkdirSync(`${file}.lock`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${file}.lock`, old, old);
    await write(file, ['{"msg":"recovered"}']);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      msg: "recovered",
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
  it("bounds archive retention and rotates when the UTC day changes", async () => {
    const file = temporaryFile();
    await write(file, ["first"]);
    utimesSync(
      file,
      new Date("2026-01-01T12:00:00Z"),
      new Date("2026-01-01T12:00:00Z"),
    );
    await write(
      file,
      ["next"],
      1000,
      2,
      () => new Date("2026-01-02T12:00:00Z"),
    );
    expect(readFileSync(`${file}.1`, "utf8")).toBe("first\n");
    await write(
      file,
      Array.from({ length: 20 }, (_, i) => JSON.stringify({ i })),
      10,
      2,
    );
    expect(
      readdirSync(join(file, "..")).filter((name) =>
        /^combined\.log(?:\.\d+)?$/.test(name),
      ),
    ).toHaveLength(3);
    expect(readFileSync(file, "utf8")).toContain('"i":19');
  });
});
