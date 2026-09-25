#!/usr/bin/env node
/** Kills whatever process is already listening on the target role's port, so start:* can always run clean. */
import { execFileSync } from "node:child_process";

const role = process.argv[2];
if (role !== "api" && role !== "worker") {
  console.error("usage: node scripts/kill-port.mjs <api|worker>");
  process.exit(2);
}

function resolvePort() {
  if (role === "api") {
    return Number(process.env.PORT) || 4000;
  }
  const url = process.env.WORKER_WAKE_URL ?? "http://127.0.0.1:4011/wake";
  return Number(new URL(url).port) || 4011;
}

const port = resolvePort();

let pids = [];
try {
  // Parse the plain listing ourselves and keep only exact "node" COMMAND
  // matches - lsof's own -c filter proved unreliable across flag
  // combinations and must never risk killing an unrelated process (e.g. a
  // system network extension) that happens to share the port.
  const output = execFileSync(
    "lsof",
    ["-nP", "-iTCP:" + port, "-sTCP:LISTEN"],
    { encoding: "utf8" },
  );
  pids = [
    ...new Set(
      output
        .split("\n")
        .slice(1) // drop the header row
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => line.split(/\s+/)[0] === "node")
        .map((line) => line.split(/\s+/)[1]),
    ),
  ];
} catch {
  // lsof exits non-zero when nothing is listening; nothing to kill.
}

for (const pid of pids) {
  try {
    process.kill(Number(pid), "SIGKILL");
    console.log(`kill-port: stopped ${role} process ${pid} on port ${port}`);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

if (pids.length === 0) {
  console.log(`kill-port: nothing listening on ${role} port ${port}`);
}
