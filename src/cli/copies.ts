/**
 * Installed-copy detection (issue #34): on a given machine several copies
 * of load-lock commonly coexist — the globally-installed CLI on PATH, and
 * the private copy opencode maintains under its npm cache (because
 * `install --harness opencode` registers the bare package name, opencode
 * installs and refreshes its own copy on its own schedule).
 *
 * All scanning is best-effort: missing paths, unreadable files, and
 * unexpected layouts yield skipped entries or null versions — never a throw.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isWindows } from "../shared/transport.js";
import { enclosingPackage, opencodeCacheRoot, PKG_NAME } from "../shared/pkginfo.js";

export { enclosingPackage, opencodeCacheRoot } from "../shared/pkginfo.js";

export interface InstalledCopy {
  /** Where this copy was found. */
  source: "cli" | "path" | "opencode-cache";
  /** Path of the copy's package root (its package.json's directory). */
  path: string;
  /** Version string, or null when the package.json could not be read. */
  version: string | null;
}

/** The copy of load-lock this process runs from (its own package root). */
export function thisCopy(): InstalledCopy | null {
  // dist/cli/copies.js -> dist/cli -> ... -> <pkg>/package.json
  const startDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const found = enclosingPackage(startDir);
  if (!found) return null;
  return { source: "cli", path: found.path, version: found.version };
}

/**
 * All installed copies of load-lock detectable on this machine:
 *  - "cli": the copy this process runs from.
 *  - "path": any `load-lock` binary found on PATH (deduped by real path,
 *    so a symlink to the running copy is recognized and not double-listed
 *    — a copy is only listed under "path" when it differs from "cli").
 *  - "opencode-cache": copies under opencode's private npm cache.
 */
export function findInstalledCopies(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): InstalledCopy[] {
  const copies: InstalledCopy[] = [];
  const seen = new Set<string>();

  const add = (c: InstalledCopy | null) => {
    if (!c) return;
    let real: string;
    try {
      real = realpathSync(c.path);
    } catch {
      real = c.path;
    }
    if (seen.has(real)) return;
    seen.add(real);
    copies.push(c);
  };

  add(thisCopy());

  // --- PATH scan ------------------------------------------------------------
  try {
    const binNames = isWindows(platform)
      ? ["load-lock.cmd", "load-lock.exe", "load-lock"]
      : ["load-lock"];
    const dirs = (env.PATH ?? "").split(isWindows(platform) ? ";" : ":").filter(Boolean);
    for (const dir of dirs) {
      for (const bin of binNames) {
        try {
          const binPath = join(dir, bin);
          if (!statSync(binPath).isFile()) continue;
          // A shim/wrapper script is not itself the copy — resolve through
          // its enclosing package (works for npm/bun global layouts where
          // the bin sits in <pkg>/bin or node_modules/.bin via a symlink).
          let realBin: string;
          try {
            realBin = realpathSync(binPath);
          } catch {
            realBin = binPath;
          }
          const found = enclosingPackage(dirname(realBin)) ?? enclosingPackage(dir);
          if (found) add({ source: "path", path: found.path, version: found.version });
        } catch {
          /* unreadable PATH entry — skip */
        }
      }
    }
  } catch {
    /* PATH scan is best-effort */
  }

  // --- opencode npm-cache scan ----------------------------------------------
  // Layout (verified live): <cacheRoot>/opencode/npm/@aron98/load-lock@latest/<ts>/
  // where "@aron98" and "load-lock@latest" are two nested directories (a
  // normal npm scoped layout); URL-escaped single-directory variants like
  // "@aron98%2Fload-lock@latest" also occur. Under each <ts>: either the
  // real package at node_modules/@aron98/load-lock, or a top-level
  // package.json (npm-install root).
  try {
    const cacheRoot = opencodeCacheRoot(platform, env);
    if (cacheRoot) {
      const npmDir = join(cacheRoot, "opencode", "npm");
      if (existsSync(npmDir)) {
        const scanTimestampDirs = (pkgBase: string): void => {
          let tsDirs: string[] = [];
          try {
            tsDirs = readdirSync(pkgBase).filter((d) => statSync(join(pkgBase, d)).isDirectory());
          } catch {
            return;
          }
          for (const ts of tsDirs) {
            const nested = join(pkgBase, ts, "node_modules", "@aron98", "load-lock");
            const topLevel = join(pkgBase, ts);
            for (const cand of [nested, topLevel]) {
              try {
                const pkgPath = join(cand, "package.json");
                if (!existsSync(pkgPath)) continue;
                const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
                if (pkg?.name !== PKG_NAME) continue;
                add({
                  source: "opencode-cache",
                  path: cand,
                  version: typeof pkg.version === "string" ? pkg.version : null,
                });
                break;
              } catch {
                /* skip unreadable timestamp dir */
              }
            }
          }
        };
        let scopeDirs: string[] = [];
        try {
          scopeDirs = readdirSync(npmDir).filter((d) => statSync(join(npmDir, d)).isDirectory());
        } catch {
          scopeDirs = [];
        }
        for (const scopeDir of scopeDirs) {
          if (scopeDir.startsWith("@aron98%2Fload-lock")) {
            // URL-escaped single-directory form.
            scanTimestampDirs(join(npmDir, scopeDir));
          } else if (scopeDir === "@aron98") {
            // Scoped layout: @aron98/<name>@<version-range>/<ts>/...
            let inner: string[] = [];
            try {
              inner = readdirSync(join(npmDir, scopeDir)).filter((d) => statSync(join(npmDir, scopeDir, d)).isDirectory());
            } catch {
              continue;
            }
            for (const nameDir of inner) {
              if (nameDir.startsWith("load-lock")) scanTimestampDirs(join(npmDir, scopeDir, nameDir));
            }
          }
        }
      }
    }
  } catch {
    /* cache scan is best-effort */
  }

  return copies;
}
