/**
 * NDJSON transport client for the load-lock daemon, shared by the CLI, the
 * MCP server, and harness hook scripts. The OpenCode plugin ships a
 * self-contained copy of this logic (see adapters/opencode).
 *
 * Transport: Unix-domain socket on POSIX, named pipe (`\\.\pipe\load-lock`)
 * on Windows — Node's `net` handles both transparently, so only endpoint
 * resolution differs (see shared/transport.ts).
 *
 * Auto-spawn: if the daemon endpoint is absent, exactly one client becomes
 * the spawner (serialized by a mkdir-based lock — atomic on POSIX and on
 * NTFS) and starts a detached daemon; losers wait for the endpoint to
 * appear. The freshly spawned daemon itself re-checks the endpoint before
 * binding, so a double-spawn is harmless (the loser exits).
 *
 * Client-only mode (LOAD_LOCK_NO_SPAWN): sandboxed clients must be thin
 * clients of the HOST daemon. A sandbox-local daemon is useless (it cannot
 * see host processes or host-wide load) and hides the failure — so when the
 * env var is set (any non-empty value except "0"), no daemon is ever
 * auto-spawned here or in ensureDaemon(); an unreachable endpoint fails
 * loudly with a pointer to the Sandboxes section of docs/OPERATIONS.md.
 */
import { connect, Socket } from "node:net";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { ProtocolError } from "./protocol.js";
import { socketPath as defaultSocket, stateDir as defaultStateDir } from "../core/persist.js";
import { probeTransport } from "./transport.js";
import { packageVersion } from "./version.js";
import { resolveDaemonEntry } from "./installs.js";

export interface ClientOptions {
  socket?: string;
  stateDir?: string;
  spawnDaemon?: boolean; // default true
}

export class LLClient {
  private sock: Socket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private eventCb: ((ev: Record<string, unknown>) => void) | null = null;
  /** Optional disconnect notifications (dashboard feeds and other watchers). */
  private disconnectCbs: Array<() => void> = [];
  private buf = "";
  private opts: Required<Omit<ClientOptions, "stateDir">> & { stateDir?: string };

  constructor(opts: ClientOptions = {}) {
    this.opts = { spawnDaemon: opts.spawnDaemon ?? true, socket: opts.socket ?? "", stateDir: opts.stateDir };
  }

  private socketPath(): string {
    return this.opts.socket || defaultSocket();
  }

  private stateDirPath(): string {
    return this.opts.stateDir || defaultStateDir();
  }

  async connect(): Promise<void> {
    try {
      await this.tryConnect();
      return;
    } catch {
      /* fall through to spawn */
    }
    if (noSpawnRequested()) {
      throw new ProtocolError("unavailable", noSpawnError(this.socketPath()));
    }
    if (!this.opts.spawnDaemon) {
      throw new ProtocolError("unavailable", `load-lock daemon is not running on ${this.socketPath()}`);
    }
    await ensureDaemon(this.stateDirPath(), this.socketPath());
    await this.tryConnect();
  }

  private tryConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = connect(this.socketPath());
      sock.once("connect", () => {
        this.attach(sock);
        resolve();
      });
      sock.once("error", (err) => {
        sock.destroy();
        reject(err);
      });
    });
  }

  private attach(sock: Socket): void {
    this.sock = sock;
    sock.on("data", (chunk) => {
      this.buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = this.buf.indexOf("\n")) !== -1) {
        const line = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 1);
        if (!line.trim()) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.event === true) {
          this.eventCb?.(msg);
          continue;
        }
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.ok) p.resolve(msg.result);
          else p.reject(new ProtocolError(msg.error?.code ?? "internal", msg.error?.message ?? "daemon error", msg.error?.details));
        }
      }
    });
    sock.on("error", () => {
      this.failAll(new ProtocolError("unavailable", "daemon connection lost"));
      this.sock = null;
      this.fireDisconnect();
    });
    sock.on("close", () => {
      this.failAll(new ProtocolError("unavailable", "daemon connection closed"));
      this.sock = null;
      this.fireDisconnect();
    });
  }

  private fireDisconnect(): void {
    // Callbacks stay registered: a long-lived consumer (e.g. a dashboard
    // feed) reconnects and must keep hearing about later disconnects.
    // Copy first — a callback may (un)register during iteration.
    for (const cb of [...this.disconnectCbs]) {
      try {
        cb();
      } catch {
        /* consumer errors must not break reconnect bookkeeping */
      }
    }
  }

  private failAll(err: ProtocolError): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private ensureSock(): Socket {
    if (!this.sock || this.sock.destroyed) throw new ProtocolError("unavailable", "not connected");
    return this.sock;
  }

  /** Issue one RPC. Reconnects once if the connection was lost. */
  async request<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<T> {
    if (method === "acquire" && params.labelPrefix === undefined) {
      // Sandbox wrapper tagging (LOAD_LOCK_LABEL_PREFIX): applied by the
      // shared client so every adapter (CLI, MCP, plugin, hooks) gets it.
      const prefix = envLabelPrefix();
      if (prefix) params = { ...params, labelPrefix: prefix };
    }
    if (!this.sock || this.sock.destroyed) await this.connect();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ProtocolError("unavailable", `timeout waiting for daemon response to ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      const sock = this.ensureSock();
      // clientVersion: lets the daemon detect version skew and self-restart
      // onto newer on-disk code (pre-handshake daemons ignore the field).
      sock.write(JSON.stringify({ id, method, params, clientVersion: packageVersion() }) + "\n");
    });
  }

  /** Subscribe to daemon events targeted at agentId (or "*" for all). */
  async watch(agentId: string, onEvent: (ev: Record<string, unknown>) => void): Promise<void> {
    this.eventCb = onEvent;
    await this.request("watch", { agentId });
  }

  /**
   * Register a callback fired whenever the daemon connection drops (socket
   * closed or errored) — including after later reconnects; the callback
   * stays registered until its unregister function is called. Dashboard
   * feeds use this to reconnect and resume via the durable event cursor.
   */
  onDisconnect(cb: () => void): () => void {
    this.disconnectCbs.push(cb);
    return () => {
      this.disconnectCbs = this.disconnectCbs.filter((c) => c !== cb);
    };
  }

  close(): void {
    this.sock?.destroy();
    this.sock = null;
  }
}

// ------------------------------------------------------------------- spawning

/**
 * Client-only mode: LOAD_LOCK_NO_SPAWN set to any non-empty value except
 * "0" forbids auto-spawning a daemon. Set this inside OS-level sandboxes
 * (bubblewrap/omac, Docker, ...) so a sandbox-local daemon is never
 * silently spawned and an unreachable host socket fails loudly instead.
 */
export function noSpawnRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.LOAD_LOCK_NO_SPAWN;
  return v !== undefined && v !== "" && v !== "0";
}

/**
 * Env-supplied holder-label prefix (LOAD_LOCK_LABEL_PREFIX), applied to
 * every acquire so sandboxed clients are identifiable in the dashboard
 * (e.g. "omac:issue-42 build"). An explicit labelPrefix param wins.
 */
export function envLabelPrefix(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = env.LOAD_LOCK_LABEL_PREFIX?.trim();
  return v || undefined;
}

function noSpawnError(sockPath: string): string {
  return (
    `load-lock daemon is not reachable at ${sockPath} and auto-spawn is disabled (LOAD_LOCK_NO_SPAWN is set): ` +
    `this client is client-only and started no daemon. Run the daemon on the host machine ` +
    `(e.g. load-lock service start) and bridge its socket into this sandbox, ` +
    `then point LOAD_LOCK_SOCKET at the bridged path — see the "Sandboxes" section of ` +
    `docs/OPERATIONS.md for per-sandbox recipes (bubblewrap/omac, Docker, seatbelt, WSL2). ` +
    `To allow spawning a daemon here instead, unset LOAD_LOCK_NO_SPAWN.`
  );
}

function daemonMainPath(): string {
  if (process.env.LOAD_LOCK_DAEMON_BIN) return process.env.LOAD_LOCK_DAEMON_BIN;
  const here = dirname(fileURLToPath(import.meta.url)); // .../dist/shared
  const own = join(here, "..", "core", "daemon-main.js");
  // Issue #39: a harness (e.g. opencode's timestamped plugin cache) may
  // prune this copy's directory while a session still executes it from
  // memory — resolve to the PATH-installed CLI's daemon entry instead of
  // spawning an ENOENT forever.
  return resolveDaemonEntry(own);
}

/** Idempotently ensure a daemon is running and listening on `sockPath`. */
export async function ensureDaemon(stateDir: string, sockPath: string): Promise<void> {
  if (noSpawnRequested()) {
    // Client-only mode: never spawn, even for direct callers.
    throw new ProtocolError("unavailable", noSpawnError(sockPath));
  }
  if (await probe(sockPath)) return;
  const lockDir = join(stateDir, "spawn.lock");
  mkdirSync(stateDir, { recursive: true });
  let holding = false;
  for (let i = 0; i < 60; i++) {
    try {
      mkdirSync(lockDir); // atomic on POSIX
      holding = true;
      writeFileSync(join(lockDir, "info"), JSON.stringify({ pid: process.pid, ts: Date.now() }));
      break;
    } catch {
      // Someone else is spawning. Clean up stale locks (older than 15s).
      try {
        const st = existsSync(join(lockDir, "info")) ? JSON.parse(readFileSync(join(lockDir, "info"), "utf8")) : null;
        if (!st || Date.now() - st.ts > 15_000) rmSync(lockDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      if (await probe(sockPath)) return;
      await delay(250);
    }
  }
  try {
    if (holding) {
      // Re-check: another spawn may have won the race while we waited.
      if (!(await probe(sockPath))) {
        const child = spawn(process.execPath, [daemonMainPath(), "--state-dir", stateDir, "--socket", sockPath], {
          detached: true,
          stdio: "ignore",
          env: { ...process.env, LOAD_LOCK_DAEMON_SPAWNED: "1" },
        });
        // Issue #39: an unreadable/vanished entry must surface as the
        // "did not come up" probe failure below, not crash the host process
        // with an uncaught ENOENT 'error' event.
        child.on("error", () => {});
        child.unref();
      }
    }
    for (let i = 0; i < 40; i++) {
      if (await probe(sockPath)) return;
      await delay(250);
    }
    throw new ProtocolError("unavailable", "load-lock daemon did not come up within 10s; run `load-lock doctor`");
  } finally {
    if (holding) rmSync(lockDir, { recursive: true, force: true });
  }
}

function probe(sockPath: string): Promise<boolean> {
  return probeTransport(sockPath);
}

/** One-shot helper: connect (auto-spawning), run fn, close. */
export async function withClient<T>(fn: (c: LLClient) => Promise<T>, opts: ClientOptions = {}): Promise<T> {
  const c = new LLClient(opts);
  try {
    await c.connect();
    return await fn(c);
  } finally {
    c.close();
  }
}
