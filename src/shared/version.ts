/**
 * Package-version plumbing for the update story (issue #34).
 *
 * Every load-lock process — daemon, CLI, MCP server, plugin — learns its
 * own on-disk package version by reading the package.json that ships next
 * to its compiled dist/ tree. That version takes part in the client→daemon
 * handshake: clients stamp every request envelope with it
 * (`clientVersion`), the daemon stamps every hello with it
 * (`daemonVersion`), and a strictly-newer client triggers a daemon
 * self-restart (see core/daemon.ts).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | undefined;

/** Version of THIS copy of load-lock (the on-disk install running now). */
export function packageVersion(): string {
  if (cached === undefined) {
    try {
      // dist/shared/version.js → <package root>/package.json — resolves the
      // same way in the repo checkout, a global CLI install, and an
      // opencode cache copy. npm always ships package.json with the tarball.
      const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
      cached = String(JSON.parse(readFileSync(pkgPath, "utf8")).version ?? "0.0.0");
    } catch {
      cached = "0.0.0";
    }
  }
  return cached;
}

/**
 * Best-effort dotted-version comparison ("1.2.1" vs "1.10.0"): numeric
 * segments compared left to right, missing segments as 0, non-numeric
 * prefixes of a segment ("2-beta" → 2) tolerated. Returns -1 / 0 / 1.
 * Unparseable input never throws — it compares as 0.0.0, so the daemon
 * never acts (restarts) on a garbage version.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function parse(v: string): number[] {
  return v
    .split(".")
    .map((seg) => {
      const m = /^(\d+)/.exec(seg.trim());
      return m ? Number(m[1]) : 0;
    });
}
