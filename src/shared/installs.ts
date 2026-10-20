/**
 * Shared install-location helpers (issue #39): resolving the PATH-installed
 * copy of the CLI, detecting version drift between the running copy and that
 * install, and finding a usable daemon entry when the running copy's own
 * entry has vanished (e.g. a harness pruned an old plugin-cache copy while a
 * session still executes it from memory).
 *
 * `enclosingPackage` / `PKG_NAME` live in `./pkginfo.js` (shipped by #38's
 * adapter-init drift notice) and are reused here; this module adds the
 * PATH-install scan and the two #39-specific probes on top of them:
 * `detectInstallDrift` (running copy OLDER than the PATH CLI — the mirror
 * image of pkginfo-neighbor `drift.ts`'s `detectCliDrift`, which flags the
 * PATH CLI being older) and `resolveDaemonEntry` (spawn fallback when this
 * copy's own entry has vanished).
 *
 * Everything here is best-effort and never throws: missing paths, unreadable
 * files, and unexpected layouts yield null / false / the input unchanged.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { isWindows } from "./transport.js";
import { compareVersions, packageVersion } from "./version.js";
import { enclosingPackage } from "./pkginfo.js";

/** All `load-lock` binaries found on PATH, in PATH order (files only). */
export function pathBinCandidates(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  const binNames = isWindows(platform) ? ["load-lock.cmd", "load-lock.exe", "load-lock"] : ["load-lock"];
  const sep = isWindows(platform) ? ";" : ":";
  const out: string[] = [];
  for (const dir of (env.PATH ?? "").split(sep).filter(Boolean)) {
    for (const bin of binNames) {
      try {
        const binPath = join(dir, bin);
        if (statSync(binPath).isFile()) out.push(binPath);
      } catch {
        /* unreadable PATH entry — skip */
      }
    }
  }
  return out;
}

export interface PathInstall {
  /** Package root of the install (the directory containing package.json). */
  path: string;
  /** Version from that package.json, or null when unreadable. */
  version: string | null;
}

/**
 * The FIRST PATH-resolved `load-lock`'s enclosing install. Symlinks are
 * resolved (npm/bun global layouts symlink the bin into the install), and a
 * plain shim script falls back to the PATH directory itself.
 */
export function pathInstall(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): PathInstall | null {
  for (const binPath of pathBinCandidates(platform, env)) {
    let realBin = binPath;
    try {
      realBin = realpathSync(binPath);
    } catch {
      /* keep the raw path */
    }
    // A shim/wrapper script is not itself the copy — resolve through its
    // enclosing package, falling back to the PATH dir (same logic the
    // doctor's multi-copy scan uses).
    const found = enclosingPackage(dirname(realBin)) ?? enclosingPackage(dirname(binPath));
    if (found) return { path: found.path, version: found.version };
  }
  return null;
}

export interface InstallDrift {
  /** Version of THIS running copy (src/shared/version.ts, cached). */
  ownVersion: string;
  /** Version of the PATH-resolved CLI install, or null when unresolvable. */
  pathVersion: string | null;
  /** True when the PATH install is strictly newer than this running copy. */
  stale: boolean;
}

/**
 * In-memory staleness probe (issue #39): a harness that loads plugin code
 * once at startup (opencode never hot-reloads plugins) keeps executing the
 * old copy after `npm i -g @aron98/load-lock@latest` — this detects exactly
 * that: the running copy vs. what the PATH `load-lock` resolves to.
 */
export function detectInstallDrift(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): InstallDrift {
  const ownVersion = packageVersion();
  const inst = pathInstall(platform, env);
  const pathVersion = inst?.version ?? null;
  return {
    ownVersion,
    pathVersion,
    stale: pathVersion != null && compareVersions(pathVersion, ownVersion) > 0,
  };
}

/**
 * Daemon entry to auto-spawn (issue #39, hypothesis 2): normally the running
 * copy's own dist/core/daemon-main.js. When that file has vanished — a
 * harness may prune its old plugin-cache timestamped dir while a session
 * still runs that copy in memory — spawn from the PATH-installed CLI's copy
 * instead, which is what the user most recently installed. If nothing on
 * PATH resolves either, the own path is returned unchanged so the spawn
 * fails with the original error rather than a misleading one.
 */
export function resolveDaemonEntry(ownEntry: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (existsSync(ownEntry)) return ownEntry;
  const inst = pathInstall(platform, env);
  if (inst) {
    const candidate = join(inst.path, "dist", "core", "daemon-main.js");
    if (existsSync(candidate)) return candidate;
  }
  return ownEntry;
}
