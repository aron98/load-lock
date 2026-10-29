#!/usr/bin/env node
/**
 * load-lock CLI: inspection, recovery, scriptable flows, execution helper.
 *
 * Exit codes: 0 ok; 1 update available (`update --check`); 64 usage; 65
 * protocol/data error; 68 not granted yet (queued/registered); 69
 * offer/claim failed; 70 internal.
 */
import { spawn, ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { LLClient, withClient } from "../shared/client.js";
import { ProtocolError } from "../shared/protocol.js";
import { waitForTurn } from "../shared/wait-turn.js";
import { waitForTrackedJob } from "../shared/wait-completion.js";
import { stateDir, socketPath } from "../core/persist.js";
import { loadRuntimes, readDaemonInfo } from "../shared/runtimes.js";
import { isWindows, probeTransport, killProcessGroup } from "../shared/transport.js";
import { packageVersion, compareVersions } from "../shared/version.js";
import { findInstalledCopies } from "./copies.js";
import { installCommand, uninstallCommand } from "./install.js";
import { hookCommand } from "./hook.js";
import { topCommand } from "./top.js";
import { awaitDaemonUpgraded, serviceRestart, serviceStart, serviceStop, ServiceError } from "./service.js";
import { updateCommand } from "./update.js";
import { sessionIdentity, type SessionIdentity } from "../shared/identity.js";

// ---------------------------------------------------------------- arg parsing

const argv = process.argv.slice(2);
let flags: Record<string, string | boolean> = {};
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--") {
    positional.push(...argv.slice(i + 1));
    break;
  } else if (a.startsWith("--")) {
    const eq = a.indexOf("=");
    if (eq !== -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
    else if (["json", "follow", "force", "admin", "quiet", "check", "version"].includes(a.slice(2))) flags[a.slice(2)] = true;
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags[a.slice(2)] = argv[++i];
    else flags[a.slice(2)] = true;
  } else {
    positional.push(a);
  }
}
const cmd = positional[0] ?? "status";
const rest = positional.slice(1);
const f = flags as Record<string, string | boolean>;
const S = (k: string, d = "") => (typeof f[k] === "string" ? (f[k] as string) : d);
const N = (k: string, d: number) => (f[k] !== undefined ? Number(f[k]) : d);
const B = (k: string) => f[k] === true;

function fail(msg: string, code = 64): never {
  process.stderr.write(`load-lock: ${msg}\n`);
  process.exit(code);
}

function out(v: unknown, human?: () => string): void {
  if (B("json")) process.stdout.write(JSON.stringify(v, null, 2) + "\n");
  else process.stdout.write((human ? human() : JSON.stringify(v, null, 2)) + "\n");
}

// Session-derived default identity (issue #49): one id per harness session,
// so CLI-driven agents on one machine no longer share `cli:$USER@$HOSTNAME`
// (that remains the fallback when no session can be found).
let identity: SessionIdentity | undefined;
function sessionId(): SessionIdentity {
  return (identity ??= sessionIdentity({
    fallback: "cli:" + (process.env.USER || "user") + "@" + (process.env.HOSTNAME || "localhost"),
  }));
}

function defaultAgent(): string {
  return sessionId().id;
}

/** Readable holder label for a session-derived id (explicit ids label themselves). */
function defaultLabel(): string | undefined {
  if (S("agent")) return undefined;
  const s = sessionId();
  return s.label !== s.id ? s.label : undefined;
}

// ---------------------------------------------------------------- help text

/**
 * One-line description per command, grouped for `load-lock help`. The first
 * name is the primary command; any further names are aliases. Keep in sync
 * with the dispatch below and the actual flag requirements.
 */
interface HelpItem {
  names: string[];
  desc: string;
}
const HELP_GROUPS: { title: string; items: HelpItem[] }[] = [
  {
    title: "permit operations",
    items: [
      { names: ["acquire"], desc: "request a permit: --pool --op-key --reason [--label] [--label-prefix] [--wait-ms] [--no-queue]" },
      { names: ["claim"], desc: "claim an offered permit before its window expires: --offer <token>" },
      { names: ["release"], desc: "release a held permit: --permit <token> [--outcome success|failure]" },
      { names: ["cancel"], desc: "cancel a queued/offered/paused request: --id <request-id> [--admin]" },
      { names: ["rejoin"], desc: "rejoin the queue after your offer expired or you declined: --id <request-id>" },
      { names: ["mark-started"], desc: "mark a permit as started when no pid can be attached: --permit <token>" },
      { names: ["attach-pid"], desc: "tie a running process to a permit (auto-release on exit): --permit <token> --pid <pid>" },
    ],
  },
  {
    title: "waiting & running",
    items: [
      { names: ["wait"], desc: "sleep until a queued request's turn (--id <request-id>), auto-claiming the offer — or until a heavy job finishes (--job <request-id>): [--timeout <ms>]" },
      { names: ["run"], desc: "acquire (or reuse) a permit and run a command under it: run [--permit <token> | acquire flags] -- <cmd>" },
    ],
  },
  {
    title: "read-only",
    items: [
      { names: ["status"], desc: "pools, holders, offers, queue — the machine-wide view" },
      { names: ["pending"], desc: "your outstanding offers, queue entries and paused requests" },
      { names: ["events"], desc: "durable event log: [--since <id>] [--follow]" },
      { names: ["inspect", "machine"], desc: "machine resources (incl. cgroup limits) and current pressure" },
      { names: ["config", "get-config"], desc: "current configuration" },
      { names: ["configure"], desc: "change configuration (compare-and-swap): --reason required" },
      { names: ["dashboard", "top"], desc: "full-screen live dashboard, read-only (never acquires): [--once]" },
      { names: ["version"], desc: "print this CLI copy's version" },
    ],
  },
  {
    title: "service & diagnostics",
    items: [
      { names: ["service"], desc: "daemon lifecycle: start | stop | restart | status (stop/start/restart take --timeout <ms> for the stop phase)" },
      { names: ["update"], desc: "check npm for a newer version, install it via the detected package manager, then `service restart` (--check dry-run; refuses repo checkouts / opencode-managed copies)" },
      { names: ["doctor"], desc: "health report: state dir, socket, daemon, versions + copies, machine" },
      { names: ["recover"], desc: "list held permits with diagnostics; recover force-release --id <request-id>" },
    ],
  },
  {
    title: "setup & docs",
    items: [
      { names: ["install"], desc: "install the load-lock adapter for a harness: --harness <name>" },
      { names: ["uninstall"], desc: "remove what install added: --harness <name>" },
      { names: ["hook"], desc: "harness hook handlers (called by integrations, not humans)" },
      { names: ["mcp"], desc: "run the MCP stdio server (same as the load-lock-mcp binary; started by harnesses, not humans)" },
      { names: ["agent-guide"], desc: "print the full agent guide" },
      { names: ["help"], desc: "this usage; also bare load-lock, --help, -h; help <command> for one line" },
    ],
  },
];

function displayName(item: HelpItem): string {
  return item.names[0] + (item.names.length > 1 ? ` (${item.names.slice(1).join(", ")})` : "");
}
const HELP_PAD = Math.max(...HELP_GROUPS.flatMap((g) => g.items.map((i) => displayName(i).length)));

function helpLine(item: HelpItem): string {
  return `  ${displayName(item).padEnd(HELP_PAD)} ${item.desc}`;
}

/** Grouped one-screen usage, printed by `help`, bare `load-lock`, `--help`/`-h`. */
function usage(): void {
  const lines: string[] = [
    "load-lock — machine-wide heavy-work budget shared by all coding agents",
    "usage: load-lock <command> [flags]        (--json works on read commands)",
  ];
  for (const g of HELP_GROUPS) {
    lines.push("", `${g.title}:`);
    for (const item of g.items) lines.push(helpLine(item));
  }
  lines.push(
    "",
    "exit codes: 0 ok, 1 update available (update --check), 64 usage, 65 protocol, 68 not granted yet, 69 offer/claim failed, 70 internal",
  );
  process.stdout.write(lines.join("\n") + "\n");
}

async function main(): Promise<void> {
  // `--version` prints this copy's version (same as the `version` command).
  if (f["version"] === true) {
    process.stdout.write(packageVersion() + "\n");
    return;
  }
  // `--help`, `-h` and a bare `load-lock` all print the same usage as `help`.
  if (f["help"] !== undefined || cmd === "-h" || (positional.length === 0 && argv.length === 0)) {
    usage();
    return;
  }
  switch (cmd) {
    // ------------------------------------------------------------- read-only
    case "status": {
      const r = await withClient((c) => c.request("status", S("pool") ? { pool: S("pool") } : {}));
      out(r, () => {
        const lines: string[] = [];
        for (const p of (r as any).pools) {
          lines.push(
            `pool "${p.pool}": ${p.used}/${p.capacity} in use (held + outstanding offers)` +
              (p.queue.length ? `, ${p.queue.length} queued` : "") +
              (p.paused.length ? `, ${p.paused.length} paused` : ""),
          );
          for (const h of p.holders) {
            const phase = h.phase === "running_tracked" ? ` [tracked pid ${h.pid ?? "?"}${h.pgid ? "/pgid " + h.pgid : ""}]` : h.phase === "claimed" ? " [claimed, awaiting start]" : h.phase === "running_untracked" ? " [untracked, leased]" : "";
            lines.push(
              `  held: ${h.agentLabel || h.agentId} — ${h.reason} (${Math.round((h.heldFor ?? 0) / 1000)}s)${phase}`,
            );
          }
          for (const o of p.offers) lines.push(`  offer: ${o.agentLabel || o.agentId} — ${o.reason} (expires in ${Math.max(0, Math.round(((o.offerExpiresAt ?? 0) - Date.now()) / 1000))}s)`);
          p.queue.forEach((q: any, i: number) => lines.push(`  queued #${i + 1}: ${q.agentLabel || q.agentId} — ${q.reason}`));
        }
        const dv = (r as any).daemon?.daemonVersion;
        if (typeof dv === "string" && compareVersions(dv, packageVersion()) < 0) {
          lines.push(
            `note: daemon v${dv} is older than this CLI v${packageVersion()} — it self-restarts on contact; run again to confirm`,
          );
        }
        return lines.join("\n");
      });
      return;
    }

    // ------------------------------------------------------------- dashboard
    case "dashboard":
    case "top": {
      // Full-screen live dashboard (read-only, never acquires a permit).
      // `dashboard` is the primary name; `top` stays as a hidden compat
      // alias. Falls back to a single rendered frame when stdout is not a
      // TTY (or with --once).
      await topCommand({ once: B("once") });
      return;
    }

    case "help": {
      // `load-lock help` — grouped one-screen usage. `help <command>` is
      // the optional per-command form: just that command's one-liner.
      const topic = rest[0];
      if (topic === undefined) {
        usage();
        return;
      }
      const item = HELP_GROUPS.flatMap((g) => g.items).find((i) => i.names.includes(topic));
      if (!item) fail(`help: unknown command "${topic}" — run "load-lock help" for the full list`);
      process.stdout.write(`load-lock ${item.names[0]} — ${item.desc}\n`);
      return;
    }

    case "inspect":
    case "machine":
      out(await withClient((c) => c.request("inspect", {})));
      return;
    case "get-config":
    case "config":
      out(await withClient((c) => c.request("get_config", {})));
      return;

    // CAS config update: --expected-version is optional for operator
    // convenience (the current version is fetched and used atomically in
    // the same connection); pass it explicitly to guard against concurrent
    // changes. All changes require --reason; the author defaults to the
    // CLI identity.
    case "configure": {
      const reason = S("reason") || fail("configure: --reason is required (changes are persisted with rationale)");
      const author = S("author", defaultAgent());
      await withClient(async (c) => {
        let expected = N("expected-version", -1);
        if (expected < 0) expected = ((await c.request("get_config", {})) as any).config.version;
        const changes: Record<string, unknown> = {};
        if (S("capacity")) changes.pools = { [S("pool", "heavy")]: { capacity: N("capacity", 1) } };
        if (S("offer-timeout-ms")) changes.offerTimeoutMs = N("offer-timeout-ms", 0);
        if (S("max-wait-ms")) changes.maxWaitMs = N("max-wait-ms", 0);
        if (S("max-turn-wait-ms")) changes.maxTurnWaitMs = N("max-turn-wait-ms", 0);
        if (S("start-timeout-ms")) changes.startTimeoutMs = N("start-timeout-ms", 0);
        if (S("untracked-lease-ms")) changes.untrackedLeaseMs = N("untracked-lease-ms", 0);
        if (S("heavy-work-heuristic")) changes.guidance = { heavyWorkHeuristic: S("heavy-work-heuristic") };
        if (!Object.keys(changes).length) fail("configure: no changes given (--capacity, --offer-timeout-ms, --max-wait-ms, --max-turn-wait-ms, --start-timeout-ms, --untracked-lease-ms, --heavy-work-heuristic)");
        out(await c.request("configure", { expectedVersion: expected, changes, reason, author }));
      });
      return;
    }

    case "pending": {
      const r = await withClient((c) => c.request("pending", { agentId: S("agent", defaultAgent()) }));
      out(r);
      return;
    }

    case "events": {
      const since = Number(S("since", "0"));
      const r = await withClient((c) => c.request("events", { sinceEventId: since, agentId: S("agent") || undefined }));
      if (B("follow")) {
        const c = new LLClient();
        await c.connect();
        await new Promise<void>(() => {
          void c.watch("*", (ev) => {
            process.stdout.write(JSON.stringify(ev) + "\n");
          });
        });
        return;
      }
      out(r);
      return;
    }

    // ------------------------------------------------------ permit operations
    case "acquire": {
      const r = await withClient((c) =>
        c.request("acquire", {
          pool: S("pool", "heavy"),
          agentId: S("agent", defaultAgent()),
          agentLabel: S("label") || defaultLabel(),
          labelPrefix: S("label-prefix") || undefined,
          cwd: S("cwd", process.cwd()),
          opKey: S("op-key") || fail("acquire: --op-key is required"),
          reason: S("reason") || fail("acquire: --reason is required"),
          waitMs: N("wait-ms", 0),
          subscribeIfBusy: !B("no-queue"),
        }),
      );
      out(r);
      if ((r as any).state === "queued" || (r as any).state === "paused") process.exit(68);
      return;
    }

    case "claim": {
      const token = S("offer") || fail("claim: --offer <token> required");
      const r = await withClient((c) => c.request("claim", { offerToken: token }));
      out(r);
      return;
    }

    case "release": {
      const token = S("permit") || fail("release: --permit <token> required");
      const r = await withClient((c) => c.request("release", { permitToken: token, outcome: S("outcome") || undefined }));
      out(r);
      return;
    }

    case "cancel": {
      const id = S("id") || fail("cancel: --id <request-id> required");
      const r = await withClient((c) => c.request("cancel", { requestId: id, admin: B("admin") }));
      out(r);
      return;
    }

    case "rejoin": {
      const id = S("id") || fail("rejoin: --id <request-id> required");
      out(await withClient((c) => c.request("rejoin", { requestId: id })));
      return;
    }

    case "mark-started": {
      const token = S("permit") || fail("mark-started: --permit <token> required");
      out(await withClient((c) => c.request("mark_started", { permitToken: token })));
      return;
    }

    case "attach-pid": {
      const token = S("permit") || fail("attach-pid: --permit <token> required");
      const pid = N("pid", 0) || fail("attach-pid: --pid required");
      out(await withClient((c) => c.request("attach_pid", { permitToken: token, pid })));
      return;
    }

    // ------------------------------------------------------- wait (offer -> permit / job -> done)
    case "wait": {
      // Two honest bounded sleeps sharing one command:
      //   --id  : queue phase — watches a queued request, auto-claims the
      //           offer when capacity reaches it, prints the permit token.
      //   --job : execution phase — sleeps until the daemon-tracked job for
      //           that request-id finishes (liveness sweep wake; the permit
      //           is released before you are woken). Structured result on
      //           every path; still_running = checkpoint, call again.
      // Both share the exact implementations with the MCP tools and the
      // OpenCode plugin (src/shared/wait-turn.ts / wait-completion.ts).
      const timeoutMs = N("timeout", 600_000);
      const c = new LLClient();
      await c.connect();
      try {
        const job = S("job");
        if (job) {
          const r = await waitForTrackedJob({ client: c, requestId: job, timeoutMs });
          out({
            state: r.state,
            request_id: r.requestId ?? job,
            exit_code: r.exitCode,
            duration_ms: r.durationMs,
            permit_released: r.permitReleased,
            waited_ms: r.waitedMs,
            effective_wait_ms: r.effectiveWaitMs,
            started_at: r.startedAt,
            detail: r.detail ?? r.nextAction,
          });
          if (r.state === "finished") return;
          if (r.state === "still_running") fail(`wait: job still running after ${r.waitedMs}ms (checkpoint — call again)`, 68);
          fail(`wait: job is ${r.state.replace(/_/g, " ")} — ${r.nextAction}`, 69);
        }
        const id = S("id") || fail("wait: --id <request-id> (queue wait) or --job <request-id> (job wait) required");
        const agent = S("agent", defaultAgent());
        const r = await waitForTurn({ client: c, agentId: agent, requestId: id, timeoutMs });
        if (r.state === "granted" && r.entry?.permitToken) {
          out({ permit_token: r.entry.permitToken, state: r.state, request_id: r.requestId, auto_claimed: r.autoClaimed ?? false });
          return;
        }
        out({ state: r.state, request_id: r.requestId, detail: r.detail ?? r.nextAction });
        if (r.state === "still_queued") fail(`wait: still queued (position ${r.queuePosition ?? "?"}) after ${r.waitedMs}ms`, 68);
        fail(`wait: request is ${r.state.replace("_", " ")} — ${r.nextAction}`, 69);
      } finally {
        c.close();
      }
    }

    // ----------------------------------------------------------- run helper
    case "run": {
      const dash = process.argv.indexOf("--");
      const jobArgv = dash !== -1 ? process.argv.slice(dash + 1) : rest.slice(1);
      if (jobArgv.length === 0) fail("run: missing command after --");
      await runWithPermit(jobArgv);
      return;
    }

    // --------------------------------------------------------------- service
    case "service": {
      const sub = rest[0] ?? "status";
      const phase = (e: unknown): never => {
        if (e instanceof ServiceError) fail(e.message, e.exitCode);
        throw e;
      };
      if (sub === "stop") {
        // Hardened stop: SIGTERM → bounded wait → SIGKILL → verified-free
        // endpoint; crash leftovers cleaned either way.
        process.stdout.write(`load-lock: ${await serviceStop(N("timeout", 5000)).catch(phase)}\n`);
        return;
      }
      if (sub === "start") {
        // Connecting auto-spawns a detached daemon (see shared/client.ts);
        // hello confirms it is up. Refusals name the conflicting pid.
        process.stdout.write(`load-lock: ${await serviceStart(N("timeout", 10_000)).catch(phase)}\n`);
        return;
      }
      if (sub === "restart") {
        // Hardened stop, then honest start — both phases reported; a
        // failure names the phase and reason (issue #38).
        const r = await serviceRestart(N("timeout", 5000), 10_000).catch(phase);
        process.stdout.write(`load-lock: ${r.stop}\nload-lock: ${r.start}\n`);
        return;
      }
      if (sub === "status") {
        const r = (await withClient((c) => c.request("hello", {}))) as any;
        out(r, () => {
          let line = `load-lock daemon: pid ${r.pid}, protocol v${r.protocolVersion}, config version ${r.configVersion}`;
          if (typeof r.daemonVersion === "string") {
            line += `, daemon v${r.daemonVersion}`;
            const installed = packageVersion();
            if (compareVersions(r.daemonVersion, installed) < 0) {
              line += ` — older than this CLI v${installed}; self-restarting on contact`;
            }
          } else {
            line += ` — pre-handshake daemon (no version report); \`load-lock service stop\` then any command restarts it on current code`;
          }
          return line;
        });
        return;
      }
      fail(`service: unknown subcommand "${sub}" (use start | stop | restart | status)`);
      return;
    }

    // ---------------------------------------------------------------- update
    case "update": {
      // issue #38: registry check → classify self → apply via the detected
      // package manager (or refuse honestly) → `service restart` on
      // success. Exit code comes from updateCommand (1 = update available
      // under --check; 70 = failure/refusal in apply mode).
      const code = await updateCommand({ check: B("check"), json: B("json") });
      if (code !== 0) process.exit(code);
      return;
    }

    case "version":
      process.stdout.write(packageVersion() + "\n");
      return;

    case "doctor": {
      const report: Record<string, unknown> = {};
      report.node = process.version;
      report.platform = process.platform;
      const dir = stateDir();
      report.stateDir = dir;
      const sock = socketPath();
      report.socket = sock;
      // Named pipes are kernel objects, not filesystem entries — probe by
      // connecting on Windows; on POSIX a file check is enough.
      report.socketExists = isWindows() ? await probeTransport(sock) : existsSync(sock);
      report.configExists = existsSync(join(dir, "config.json"));
      report.journalExists = existsSync(join(dir, "journal.json"));
      report.installedVersion = packageVersion();
      const warnings: string[] = [];
      try {
        // One connection for hello + inspect: if the handshake orders a
        // self-restart (daemon older than this CLI), both requests must
        // finish before the daemon drains and exits.
        const { hello, insp } = await withClient(async (c) => ({
          hello: await c.request("hello", {}),
          insp: await c.request("inspect", {}),
        }));
        report.hello = hello;
        report.effectiveCores = (insp as any).cpu.effectiveCores;
        report.pressure = (insp as any).pressure.note;
        report.procs = (insp as any).cpu.cgroupVersion;
        const dv = (hello as any).daemonVersion;
        if (typeof dv === "string") {
          const installed = packageVersion();
          if (compareVersions(dv, installed) < 0) {
            warnings.push(
              `daemon v${dv} is older than this CLI v${installed}; the version handshake ordered it to self-restart`,
            );
            const up = await awaitDaemonUpgraded(sock, 5000, installed);
            if (up) {
              report.daemonUpgradedTo = up.daemonVersion;
              warnings.push(`daemon self-restarted to v${up.daemonVersion} (pid ${up.pid}) — now up to date`);
            } else {
              warnings.push(
                `daemon did not come back on v${installed} within 5s (its on-disk copy may not be updated in place — ` +
                  `see docs/OPERATIONS.md "Update lifecycle"); the next client contact retries the restart`,
              );
            }
          }
        } else {
          warnings.push(
            `pre-handshake daemon (no version in hello): restart it onto current code — \`load-lock service stop\`, then any load-lock command`,
          );
        }
      } catch (e) {
        report.daemon = `unreachable: ${(e as Error).message}`;
      }
      // Multi-copy reality (issue #34): list every detectable copy and warn
      // when their versions drift apart.
      const copies = findInstalledCopies();
      report.copies = copies;
      // Runtime copies the daemon has seen via the handshake (issue #52),
      // and the copy the daemon itself runs from.
      const dinfo = readDaemonInfo(dir);
      if (dinfo?.packageRoot) report.daemonRuntime = { path: dinfo.packageRoot, version: dinfo.version ?? null };
      report.knownRuntimes = loadRuntimes(dir);
      const versions = new Set(copies.map((c) => c.version).filter((v): v is string => v !== null));
      if (versions.size > 1) {
        warnings.push(
          `multiple load-lock versions installed (${[...versions].sort().join(", ")}): ` +
            copies.map((c) => `${c.source}=${c.version ?? "?"} (${c.path})`).join("; ") +
            ` — see docs/COMPATIBILITY.md "Multiple copies of load-lock" for which copy is authoritative for what`,
        );
      }
      report.warnings = warnings;
      out(report, () => JSON.stringify(report, null, 2));
      return;
    }

    case "recover": {
      const sub = rest[0] ?? "list";
      if (sub === "list" || sub === "orphans") {
        const r = await withClient((c) => c.request("admin_list", {}));
        out(r, () => {
          const hs = (r as any).holders as any[];
          if (!hs.length) return "load-lock: no held permits";
          return (
            "load-lock: held permits (recovery diagnostics)\n" +
            hs
              .map((h) => `  ${h.entry.requestId} [${h.entry.phase}] ${h.entry.agentLabel || h.entry.agentId} — ${h.entry.reason}\n    ${h.diagnostics.note}`)
              .join("\n")
          );
        });
        return;
      }
      if (sub === "force-release") {
        const id = S("id") || fail("recover force-release: --id required");
        await withClient((c) => c.request("admin_release", { requestId: id }));
        process.stdout.write(`load-lock: force-released ${id}\n`);
        return;
      }
      fail(`recover: unknown subcommand "${sub}"`);
      return;
    }

    // ------------------------------------------------------------- installer
    case "install":
      await installCommand({
        harness: S("harness"),
        project: S("project", process.cwd()),
        json: B("json"),
        global: true,
        binDir: import.meta.dirname ? join(import.meta.dirname, "..") : undefined,
      });
      return;
    case "uninstall":
      await uninstallCommand({ harness: S("harness"), project: S("project", process.cwd()) });
      return;

    // ------------------------------------------------------------------ hooks
    case "hook":
      await hookCommand(rest);
      return;

    // ------------------------------------------------------------ mcp server
    // Same server as the `load-lock-mcp` bin, reachable through the default
    // `load-lock` bin so `npx -y @aron98/load-lock@<pin> mcp` works (ACE, #65).
    // Imported lazily: other commands never load the MCP SDK.
    case "mcp": {
      const { runStdioMcp } = await import("../mcp/server.js");
      await runStdioMcp();
      return;
    }

    case "agent-guide": {
      const p = join(import.meta.dirname ?? ".", "..", "..", "docs", "AGENT_GUIDE.md");
      process.stdout.write(readFileSync(existsSync(p) ? p : join(import.meta.dirname ?? ".", "..", "..", "docs", "AGENT_GUIDE.md"), "utf8"));
      return;
    }

    default:
      fail(`unknown command "${cmd}" — run "load-lock help" for the list of commands`);
  }
}

// ------------------------------------------------------------------ run helper

/**
 * `load-lock run [--permit TOKEN | acquire flags] -- cmd...`
 *
 * Owns the process lifecycle: acquires (or uses a claimed permit), spawns the
 * job in its own process group, atomically associates it with the permit,
 * waits, and releases with the job's outcome. The job outliving the helper
 * (helper killed, session gone) is safe: the daemon watches the process
 * group and releases the permit when the job actually exits. The permit is
 * NOT released merely because a background-task id was returned — only on
 * real process exit.
 */
async function runWithPermit(jobArgv: string[]): Promise<void> {
  const command = jobArgv.join(" ");
  const client = new LLClient();
  await client.connect();
  try {
    let permitToken = S("permit");
    if (!permitToken) {
      const acq = (await client.request("acquire", {
        pool: S("pool", "heavy"),
        agentId: S("agent", defaultAgent()),
        agentLabel: S("label") || "load-lock run",
        labelPrefix: S("label-prefix") || undefined,
        cwd: process.cwd(),
        opKey: S("op-key") || `run/${command}/${Date.now()}`,
        reason: S("reason") || command,
        waitMs: N("wait-ms", 5_000),
      })) as any;
      if (acq.state === "queued") {
        process.stdout.write(`load-lock: queued at position ${acq.entry.position} (request ${acq.entry.requestId}); increase --wait-ms or use load-lock wait\n`);
        process.exit(68);
      }
      permitToken = acq.entry.permitToken;
    }
    // Spawn in its own process group so subprocesses/background jobs count.
    // If the job was given as a single shell string, run it through a shell;
    // if it was given as explicit argv (multiple args after --), exec directly
    // so quoting survives.
    const single = jobArgv.length === 1;
    const spawnOpts = { detached: true, stdio: "inherit" as const, cwd: S("cwd", process.cwd()), env: process.env };
    const child = (single
      ? spawn(jobArgv[0], { ...spawnOpts, shell: true })
      : spawn(jobArgv[0], jobArgv.slice(1), spawnOpts)) as ChildProcess;
    const pgid = child.pid!;
    // Register the exit watcher BEFORE any await: if the job exits while we
    // are still associating the permit, the otherwise-unobserved exit event
    // would be lost and this helper would hang forever.
    const exited = new Promise<number | null>((resolveExit, rejectExit) => {
      child.on("exit", (c, sig) => resolveExit(c ?? (sig ? 70 /* killed by signal */ : 0)));
      child.on("error", (e) => rejectExit(e));
    });
    // Atomic association: if the permit was reclaimed in the interim, kill
    // the freshly spawned job before it does meaningful work.
    try {
      await client.request("start_job", { permitToken, pid: child.pid, pgid });
    } catch (err) {
      killProcessGroup(pgid, "SIGKILL");
      fail(`permit no longer startable (${(err as Error).message}); job not started`, 69);
    }
    const forward = (sig: "SIGTERM" | "SIGINT") => {
      killProcessGroup(pgid, sig);
    };
    process.on("SIGTERM", () => forward("SIGTERM"));
    process.on("SIGINT", () => forward("SIGINT"));
    let code: number | null;
    try {
      code = await exited;
    } catch (e) {
      fail(`failed to run command: ${(e as Error).message}`, 65);
    }
    await client
      .request("release", { permitToken, outcome: code === 0 ? "success" : "failure" })
      .catch((e) => {
        if (e instanceof ProtocolError && e.code === "stale_token") return; // already auto-released
        throw e;
      });
    process.exit(code === null ? 1 : code);
  } finally {
    client.close();
  }
}

main().catch((e) => {
  if (e instanceof ProtocolError) fail(e.message, e.code === "unavailable" ? 70 : 65);
  fail((e as Error)?.stack ?? String(e), 70);
});
