/**
 * Adapter-init drift notice (issue #38): when a harness adapter copy NEWER
 * than the PATH-installed `load-lock` CLI initializes — typically because
 * opencode refreshed its private cache copy — surface ONE clear notice
 * naming the exact command (`load-lock update`).
 *
 * Notify-first, NEVER auto-install: spawning a package manager from inside
 * a harness plugin needs explicit opt-in; the default is to tell the
 * agent/user, who can run `load-lock update` as an ordinary command or
 * tool call.
 *
 * Honest limitation (documented in docs/OPERATIONS.md): a harness session
 * that was already running keeps the OLD adapter code in memory until the
 * harness restarts — this notice is emitted by the NEW copy at its init,
 * which is the best it can do for sessions started before the refresh.
 *
 * npx-vs-PATH skew (issue #57): an MCP server launched via a pinned
 * `npx -y @aron98/load-lock@<pin>` runs from the npx cache; when that copy
 * is newer than the PATH CLI the notice names it as the npx copy.
 *
 * Pure and synchronous (PATH scan + package.json reads only) so both the
 * OpenCode plugin setup and the MCP server startup can call it inline.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, sep as pathSep } from "node:path";
import { fileURLToPath } from "node:url";
import { isWindows } from "./transport.js";
import { enclosingPackage, npxCacheRoot, PKG_NAME } from "./pkginfo.js";
import { compareVersions } from "./version.js";

export interface CliDrift {
  /** Version of this (adapter) copy — the newer one. */
  ownVersion: string;
  /** Version of the PATH-resolved `load-lock` CLI copy — the older one. */
  cliVersion: string;
  /** Package root of the PATH-resolved CLI copy. */
  cliPath: string;
  /** Where this (adapter) copy lives: the npx cache, or anywhere else. */
  ownSource: "npx-cache" | "adapter";
  /** The one clear notice, with the exact command. */
  message: string;
}

/** The notice text (exported for tests and doc-sync checks). */
export function driftMessage(ownVersion: string, cliVersion: string, ownSource: CliDrift["ownSource"] = "adapter"): string {
  const own = ownSource === "npx-cache" ? "npx-cache copy (launched via npx)" : "adapter copy";
  return (
    `load-lock: this load-lock ${own} (v${ownVersion}) is newer than the installed CLI (v${cliVersion}). ` +
    `Run \`load-lock update\` to update the CLI on PATH and restart the daemon. ` +
    `(Notify only — nothing is auto-installed; if your CLI predates the \`update\` command, run ` +
    `\`npm i -g ${PKG_NAME}@latest\` instead.)`
  );
}

/** Package root of the copy this module runs from, or null. */
function ownPackageRoot(): string | null {
  try {
    return enclosingPackage(dirname(dirname(fileURLToPath(import.meta.url))))?.path ?? null;
  } catch {
    return null;
  }
}

/**
 * Compare `ownVersion` (this adapter copy) with the version of the
 * `load-lock` binary that PATH resolves to, by reading that copy's
 * package.json — never by spawning the old CLI, which may predate any
 * introspection. Returns a drift notice when the PATH CLI is strictly
 * older; null when it is the same or newer, absent, or unreadable.
 * Best-effort: never throws.
 */
export function detectCliDrift(
  ownVersion: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  ownPath: string | null = ownPackageRoot(),
): CliDrift | null {
  try {
    const npxRoot = npxCacheRoot(platform, env);
    const ownSource: CliDrift["ownSource"] =
      ownPath && npxRoot && (ownPath + pathSep).startsWith(npxRoot.endsWith(pathSep) ? npxRoot : npxRoot + pathSep) ? "npx-cache" : "adapter";
    const sep = isWindows(platform) ? ";" : ":";
    const binNames = isWindows(platform) ? ["load-lock.cmd", "load-lock.exe", "load-lock"] : ["load-lock"];
    const dirs = (env.PATH ?? "").split(sep).filter(Boolean);
    for (const dir of dirs) {
      for (const bin of binNames) {
        const binPath = join(dir, bin);
        if (!existsSync(binPath) || !statSync(binPath).isFile()) continue;
        // Resolve through symlinks/shims to the copy that owns the bin.
        let realBin: string;
        try {
          realBin = realpathSync(binPath);
        } catch {
          realBin = binPath;
        }
        const found = enclosingPackage(dirname(realBin)) ?? enclosingPackage(dir);
        if (!found || found.version === null) return null; // first PATH hit wins; cannot compare honestly
        if (compareVersions(found.version, ownVersion) < 0) {
          return {
            ownVersion,
            cliVersion: found.version,
            cliPath: found.path,
            ownSource,
            message: driftMessage(ownVersion, found.version, ownSource),
          };
        }
        return null; // PATH CLI is same/newer — no drift
      }
    }
  } catch {
    /* best-effort: unreadable PATH entries are skipped, never fatal */
  }
  return null; // no load-lock on PATH — nothing to compare against
}
