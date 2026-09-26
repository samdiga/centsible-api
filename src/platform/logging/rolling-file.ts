import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { Writable } from "node:stream";

export type RollingFileOptions = {
  file: string;
  maxBytes?: number;
  retain?: number;
  now?: () => Date;
  fallback?: (chunk: Buffer) => void;
};
const MAX_BYTES = 10 * 1024 * 1024;
const RETAIN = 7;

/** Both processes take this same lock for the complete rotate/append operation. */
async function append(
  options: RollingFileOptions,
  chunk: Buffer,
): Promise<void> {
  // The lock library installs process signal handlers: load it only for file output.
  const { default: lockfile } = await import("proper-lockfile");
  const file = resolve(options.file);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  let compromised: Error | undefined;
  const release = await lockfile.lock(file, {
    realpath: false,
    onCompromised(error) {
      compromised = error;
    },
    stale: 30_000,
    update: 1_000,
    retries: { retries: 100, factor: 1, minTimeout: 20, maxTimeout: 20 },
  });
  try {
    if (compromised) throw compromised;
    const current = existsSync(file) ? statSync(file) : null;
    const today = (options.now?.() ?? new Date()).toISOString().slice(0, 10);
    if (
      current &&
      current.size > 0 &&
      (current.size + chunk.byteLength > (options.maxBytes ?? MAX_BYTES) ||
        current.mtime.toISOString().slice(0, 10) !== today)
    ) {
      const retain = options.retain ?? RETAIN;
      if (existsSync(`${file}.${retain}`)) unlinkSync(`${file}.${retain}`);
      for (let index = retain - 1; index >= 1; index -= 1) {
        if (existsSync(`${file}.${index}`))
          renameSync(`${file}.${index}`, `${file}.${index + 1}`);
      }
      renameSync(file, `${file}.1`);
    }
    const originalSize = existsSync(file) ? statSync(file).size : 0;
    const fd = openSync(file, "a", 0o600);
    try {
      let offset = 0;
      while (offset < chunk.byteLength) {
        offset += writeSync(fd, chunk, offset, chunk.byteLength - offset);
      }
    } catch (error) {
      // Do not leave a truncated JSON record ahead of the next log entry.
      ftruncateSync(fd, originalSize);
      throw error;
    } finally {
      closeSync(fd);
    }
  } finally {
    await release();
  }
}

/** Writable queues each process's entries; the shared lock serializes processes. */
export function createRollingFileDestination(
  options: RollingFileOptions,
): Writable {
  if (
    !Number.isSafeInteger(options.maxBytes ?? MAX_BYTES) ||
    (options.maxBytes ?? MAX_BYTES) <= 0 ||
    !Number.isSafeInteger(options.retain ?? RETAIN) ||
    (options.retain ?? RETAIN) <= 0
  ) {
    throw new Error(
      "Log rotation size and retention must be positive integers",
    );
  }
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (!chunk.byteLength) {
        callback();
        return;
      }
      void append(options, chunk).then(
        () => callback(),
        () => {
          // The chunk has already passed through the logger's redaction hooks.
          if (options.fallback) options.fallback(chunk);
          else {
            try {
              writeSync(2, "[logging] File output unavailable; using stderr\n");
              writeSync(2, chunk);
            } catch {
              /* No writable diagnostic destination remains. */
            }
          }
          callback();
        },
      );
    },
  });
}

export function defaultLogDestination(): Writable | undefined {
  if (process.env.NODE_ENV === "test") return undefined;
  return createRollingFileDestination({
    file: process.env.LOG_FILE ?? resolve(".logs", "centsible.log"),
  });
}
