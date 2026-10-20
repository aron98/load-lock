/**
 * Package-identity plumbing shared by copy detection (cli/copies.ts), the
 * update command (cli/update.ts), and the adapter drift notice
 * (shared/drift.ts): the package name and the "which package root
 * contains this file" climb.
 *
 * Pure functions of their arguments (no process.env / import.meta at call
 * time beyond what callers pass in) so tests can plant layouts.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** Package name of this package (used to find enclosing package roots). */
export const PKG_NAME = "@aron98/load-lock";

export interface PkgRootInfo {
  /** Package root (the directory holding the matching package.json). */
  path: string;
  /** Version string, or null when the package.json has no/invalid version. */
  version: string | null;
}

/**
 * Find the package.json of the @aron98/load-lock copy that contains the
 * given file, by climbing parent directories. Best-effort: returns null if
 * no enclosing package.json matches (or is readable).
 */
export function enclosingPackage(startDir: string, maxDepth = 12): PkgRootInfo | null {
  let dir = startDir;
  for (let i = 0; i < maxDepth; i++) {
    const pkgPath = join(dir, "package.json");
    try {
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (pkg?.name === PKG_NAME) {
          return { path: dir, version: typeof pkg.version === "string" ? pkg.version : null };
        }
        // A foreign package.json terminates the climb (e.g. a PATH bin
        // inside some other tool's package).
        return null;
      }
    } catch {
      return null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Cache root the way opencode resolves it (its npm cache lives under it). */
export function opencodeCacheRoot(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | null {
  if (env.XDG_CACHE_HOME) return env.XDG_CACHE_HOME;
  if (platform === "win32") return env.LOCALAPPDATA ?? null;
  if (platform === "darwin") return join(env.HOME ?? homedir(), "Library", "Caches");
  return join(env.HOME ?? homedir(), ".cache");
}
