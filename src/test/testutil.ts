/**
 * Shared helpers for integration tests (not matched by the test-file pattern).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { LLClient } from "../shared/client.js";

const TMP_BASE = join(tmpdir(), "opencode");
mkdirSync(TMP_BASE, { recursive: true });

export const daemonMainPath = join(dirname(fileURLToPath(import.meta.url)), "..", "core", "daemon-main.js");
export const cliMainPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli", "main.js");
export const mcpMainPath = join(dirname(fileURLToPath(import.meta.url)), "..", "mcp", "main.js");

export interface DaemonHandle {
  child: ChildProcess;
  dir: string;
  sock: string;
  env: Record<string, string>;
  client(): LLClient;
  stop(): Promise<void>;
}

export async function startDaemon(): Promise<DaemonHandle> {
  const dir = mkdtempSync(join(TMP_BASE, "ll-daemon-"));
  const sock = join(dir, "daemon.sock");
  const env = {
    ...process.env,
    LOAD_LOCK_STATE_DIR: dir,
    LOAD_LOCK_SOCKET: sock,
  } as Record<string, string>;
  const child = spawn(process.execPath, [daemonMainPath, "--state-dir", dir, "--socket", sock], {
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (await probe(sock)) break;
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error("daemon did not come up");
    }
    await delay(100);
  }
  const handle: DaemonHandle = {
    child,
    dir,
    sock,
    env,
    client: () => new LLClient({ socket: sock, stateDir: dir, spawnDaemon: false }),
    stop: async () => {
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
          }, 3000);
          child.once("exit", () => {
            clearTimeout(t);
            resolve();
          });
        });
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return handle;
}

export function probe(sock: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(sock);
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function until(desc: string, fn: () => boolean | Promise<boolean>, timeoutMs = 15_000, step = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting for: ${desc}`);
    await delay(step);
  }
}

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run the compiled CLI as a separate process against the given daemon env. */
export function runCli(d: DaemonHandle, args: string[], input?: string, timeoutMs = 60_000): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliMainPath, ...args], { env: d.env });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (b) => (stdout += b));
    child.stderr!.on("data", (b) => (stderr += b));
    if (input !== undefined) child.stdin!.end(input);
    else child.stdin!.end();
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out: load-lock ${args.join(" ")}`));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
