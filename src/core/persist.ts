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

export function loadState(dir: string): { config: MachineConfig; history: ConfigHistoryEntry[] } {
  const path = join(dir, "config.json");
  if (!existsSync(path)) return { config: defaultConfig(), history: [] };
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const config = { ...defaultConfig(), ...raw.config } as MachineConfig;
  // Defensive: always at least the default pool.
  if (!config.pools || Object.keys(config.pools).length === 0) config.pools = { heavy: { capacity: 1 } };
  return { config, history: Array.isArray(raw.history) ? raw.history : [] };
}

export function saveState(dir: string, config: MachineConfig, history: ConfigHistoryEntry[]): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "config.json");
  const tmp = join(dirname(path), ".config.json.tmp-" + process.pid);
  writeFileSync(tmp, JSON.stringify({ config, history }, null, 2) + "\n", { mode: 0o644 });
  renameSync(tmp, path); // atomic on POSIX
}

// --------------------------------------------------------------------------
// Journal: held permits, persisted so a daemon restart can conservatively
// reconcile running ownership (tracked jobs keep their permit; confirmed-dead
// jobs release; queued/offered requests are NOT journaled — agents re-acquire).

export function journalPath(dir: string): string {
  return join(dir, "journal.json");
}

export function loadJournal(dir: string): JournalEntry[] {
  try {
    const raw = JSON.parse(readFileSync(journalPath(dir), "utf8"));
    return Array.isArray(raw) ? (raw as JournalEntry[]) : [];
  } catch {
    return [];
  }
}

export function saveJournal(dir: string, entries: JournalEntry[]): void {
  const path = journalPath(dir);
  const tmp = join(dirname(path), ".journal.json.tmp-" + process.pid);
  writeFileSync(tmp, JSON.stringify(entries, null, 2) + "\n", { mode: 0o644 });
  renameSync(tmp, path);
}
