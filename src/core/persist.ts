/**
 * Atomic JSON persistence for daemon config + change history.
 * State dir: $XDG_STATE_HOME/load-lock (default ~/.local/state/load-lock;
 * Windows: %LOCALAPPDATA%\load-lock — see shared/transport.ts).
 *
 * Configuration persists across daemon restarts, plus the journal
 * (journal.json): held permits AND queued/offered requests. Held permits
 * are restored conservatively (tracked jobs re-checked for liveness, same
 * permit tokens so late releases stay idempotent); queued requests are
 * re-queued FIFO with the same requestIds (see docs/ARCHITECTURE.md).
 */
import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { MachineConfig, ConfigHistoryEntry, JournalEntry } from "../shared/protocol.js";
import { defaultConfig } from "./state.js";
import { resolveStateDir, resolveSocketPath } from "../shared/transport.js";

export function stateDir(override?: string): string {
  return resolveStateDir(process.platform, process.env, override);
}

export function socketPath(override?: string): string {
  return resolveSocketPath(process.platform, process.env, override);
}

// --------------------------------------------------------------------------
// Format version + compatibility (issue #51). Several runtime copies may share
// one state dir, so an OLDER daemon can load files written by a NEWER one
// (downgrade) and vice versa. The promise (docs/ARCHITECTURE.md):
//  - format changes are additive; readers ignore what they don't understand;
//  - unknown fields survive a rewrite (config.json: top level, inside
//    `config`, inside pools; journal: per entry while the entry is live);
//  - unknown journal entry kinds are skipped (reported), never fatal;
//  - an incompatible change would use a NEW file name, never reinterpret
//    these files.
// Files written before versioning carry no formatVersion (=> 0).

/** Format version this code writes into config.json and journal entries. */
export const STATE_FORMAT_VERSION = 1;

const KNOWN_STATE_KEYS = new Set(["formatVersion", "config", "history"]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function loadState(dir: string): { config: MachineConfig; history: ConfigHistoryEntry[]; formatVersion: number } {
  const path = join(dir, "config.json");
  if (!existsSync(path)) return { config: defaultConfig(), history: [], formatVersion: STATE_FORMAT_VERSION };
  const raw = JSON.parse(readFileSync(path, "utf8"));
  // Unknown fields inside `config` ride along in memory and are written back
  // by saveState (configure() mutates in place).
  const config = { ...defaultConfig(), ...(isObject(raw?.config) ? raw.config : {}) } as MachineConfig;
  // Defensive: always at least the default pool.
  if (!isObject(config.pools) || Object.keys(config.pools).length === 0) config.pools = { heavy: { capacity: 1 } };
  const formatVersion = typeof raw?.formatVersion === "number" ? raw.formatVersion : 0;
  return { config, history: Array.isArray(raw?.history) ? raw.history : [], formatVersion };
}

export function saveState(dir: string, config: MachineConfig, history: ConfigHistoryEntry[]): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "config.json");
  // Preserve top-level fields written by a newer format (never rewrite
  // destructively). Best-effort: an unreadable file has nothing to keep.
  const extra: Record<string, unknown> = {};
  try {
    const prev = JSON.parse(readFileSync(path, "utf8"));
    if (isObject(prev)) for (const [k, v] of Object.entries(prev)) if (!KNOWN_STATE_KEYS.has(k)) extra[k] = v;
  } catch {
    /* missing or corrupt: nothing to preserve */
  }
  const tmp = join(dirname(path), ".config.json.tmp-" + process.pid);
  writeFileSync(tmp, JSON.stringify({ formatVersion: STATE_FORMAT_VERSION, ...extra, config, history }, null, 2) + "\n", { mode: 0o644 });
  renameSync(tmp, path); // atomic on POSIX
}

// --------------------------------------------------------------------------
// Journal: held permits AND queued/offered requests, persisted so a daemon
// restart can conservatively reconcile running ownership (tracked jobs keep
// their permit; confirmed-dead jobs release) and re-queue waiters FIFO with
// the same requestIds (offered entries come back as queued; issue #34).

export function journalPath(dir: string): string {
  return join(dir, "journal.json");
}

// The journal stays a bare JSON array (what every released daemon reads); the
// format version is stamped per entry. An object form `{ entries: [...] }` is
// accepted too, so a future format may wrap the array without breaking us.
export function loadJournal(dir: string): JournalEntry[] {
  try {
    const raw = JSON.parse(readFileSync(journalPath(dir), "utf8"));
    const list = Array.isArray(raw) ? raw : isObject(raw) && Array.isArray(raw.entries) ? raw.entries : [];
    return list.filter(isObject) as unknown as JournalEntry[];
  } catch {
    return [];
  }
}

export function saveJournal(dir: string, entries: JournalEntry[]): void {
  const path = journalPath(dir);
  const tmp = join(dirname(path), ".journal.json.tmp-" + process.pid);
  const stamped = entries.map((e) => ({ formatVersion: STATE_FORMAT_VERSION, ...e }));
  writeFileSync(tmp, JSON.stringify(stamped, null, 2) + "\n", { mode: 0o644 });
  renameSync(tmp, path);
}
