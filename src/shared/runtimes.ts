/**
 * Runtime-copy bookkeeping (issue #52): which load-lock copies (package
 * roots) have talked to this machine's daemon.
 *
 * The daemon records its own runtime in `daemon.json` and every copy seen
 * via the client handshake (`clientRoot` in the request envelope) in
 * `runtimes.json` next to it. Small entry points (skill, plugin launchers)
 * and `doctor` read these to find an existing runtime without npx.
 *
 * Everything here is best-effort: unreadable/missing files yield empty
 * lists, never a throw. A client's path hint is never trusted for the
 * version — it is re-read from the copy's own package.json on disk.
 */
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PKG_NAME } from "./pkginfo.js";

export interface RuntimeCopy {
  /** Real path of the copy's package root. */
  path: string;
  /** Version read from the copy's package.json (not from the client). */
  version: string;
  /** Epoch ms of the last handshake from this copy. */
  lastSeen: number;
}

/** daemon.json contents (fields beyond pid/startedAt/socket since #52). */
export interface DaemonInfo {
  pid: number;
  startedAt: number;
  socket: string;
  /** Package root the daemon runs from (since #52). */
  packageRoot?: string;
  /** Package version the daemon runs (since #52). */
  version?: string;
}

/** Cap on remembered copies; the least recently seen are dropped first. */
export const MAX_RUNTIMES = 32;

export function runtimesPath(stateDir: string): string {
  return join(stateDir, "runtimes.json");
}

/**
 * Validate a package root: it must hold a package.json naming
 * @aron98/load-lock with a string version. Returns the real path and the
 * on-disk version, or null.
 */
export function inspectPackageRoot(root: string): { path: string; version: string } | null {
  try {
    const real = realpathSync(root);
    const pkg = JSON.parse(readFileSync(join(real, "package.json"), "utf8"));
    if (pkg?.name !== PKG_NAME || typeof pkg.version !== "string") return null;
    return { path: real, version: pkg.version };
  } catch {
    return null;
  }
}

/** Known copies from the state dir, dropping entries whose path is gone. */
export function loadRuntimes(stateDir: string): RuntimeCopy[] {
  try {
    const raw = JSON.parse(readFileSync(runtimesPath(stateDir), "utf8"));
    const list: unknown[] = Array.isArray(raw?.copies) ? raw.copies : [];
    return list.filter(
      (c): c is RuntimeCopy =>
        typeof (c as RuntimeCopy)?.path === "string" &&
        typeof (c as RuntimeCopy).version === "string" &&
        typeof (c as RuntimeCopy).lastSeen === "number" &&
        existsSync(join((c as RuntimeCopy).path, "package.json")),
    );
  } catch {
    return [];
  }
}

export function saveRuntimes(stateDir: string, copies: RuntimeCopy[]): void {
  const path = runtimesPath(stateDir);
  const tmp = join(stateDir, ".runtimes.json.tmp-" + process.pid);
  writeFileSync(tmp, JSON.stringify({ copies }, null, 2) + "\n", { mode: 0o644 });
  renameSync(tmp, path);
}

/**
 * Merge one sighting into the list (dedupe by real path, newest first,
 * capped). Returns the new list, or null when the root is not a valid
 * load-lock copy.
 */
export function mergeRuntime(copies: RuntimeCopy[], root: string, now: number): RuntimeCopy[] | null {
  const found = inspectPackageRoot(root);
  if (!found) return null;
  const rest = copies.filter((c) => c.path !== found.path);
  return [{ path: found.path, version: found.version, lastSeen: now }, ...rest]
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, MAX_RUNTIMES);
}

/** daemon.json contents, or null when missing/unreadable. */
export function readDaemonInfo(stateDir: string): DaemonInfo | null {
  try {
    return JSON.parse(readFileSync(join(stateDir, "daemon.json"), "utf8"));
  } catch {
    return null;
  }
}
