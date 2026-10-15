#!/usr/bin/env node
/**
 * load-lock CLI: inspection, recovery, scriptable flows, execution helper.
 *
 * Exit codes: 0 ok; 64 usage; 65 protocol/data error; 68 not granted yet
 * (queued/registered); 69 offer/claim failed; 70 internal.
 */
import { spawn, ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { LLClient, withClient } from "../shared/client.js";
import { ProtocolError } from "../shared/protocol.js";
import { installCommand, uninstallCommand } from "./install.js";
import { hookCommand } from "./hook.js";

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
    else if (["json", "follow", "force", "admin", "quiet"].includes(a.slice(2))) flags[a.slice(2)] = true;
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

function defaultAgent(): string {
  return (
    process.env.LOAD_LOCK_AGENT ||
    "cli:" + (process.env.USER || "user") + "@" + (process.env.HOSTNAME || "localhost")
  );
}

async function main(): Promise<void> {
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
        return lines.join("\n");
      });
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
        if (S("start-timeout-ms")) changes.startTimeoutMs = N("start-timeout-ms", 0);
        if (S("untracked-lease-ms")) changes.untrackedLeaseMs = N("untracked-lease-ms", 0);
        if (S("heavy-work-heuristic")) changes.guidance = { heavyWorkHeuristic: S("heavy-work-heuristic") };
        if (!Object.keys(changes).length) fail("configure: no changes given (--capacity, --offer-timeout-ms, --max-wait-ms, --start-timeout-ms, --untracked-lease-ms, --heavy-work-heuristic)");
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
          agentLabel: S("label") || undefined,
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

    // ------------------------------------------------------- wait (offer -> permit)
    case "wait": {
      // Watches a queued request; auto-claims the offer when capacity is
      // handed to it and prints the permit token. Honest bounded blocking
      // for scriptable flows (aider, plain shell scripts).
      const id = S("id") || fail("wait: --id <request-id> required");
      const timeoutMs = N("timeout", 600_000);
      const agent = S("agent", defaultAgent());
      const c = new LLClient();
      await c.connect();
      try {
        let last = 0;
        let resolved = false;
        const permit = await new Promise<string | null>((resolve) => {
          const finish = (v: string | null) => {
            if (!resolved) {
              resolved = true;
              resolve(v);
            }
          };
          const timer = timeoutMs > 0 ? setTimeout(() => finish(null), timeoutMs) : null;
          void (async () => {
            while (!resolved) {
              try {
                const r = (await c.request("events", { sinceEventId: last, agentId: agent })) as any;
                last = r.latestEventId;
                for (const ev of r.events as any[]) {
                  if (ev.entry?.requestId !== id) continue;
                  if (ev.type === "offered" && ev.offerToken) {
                    const claimed = (await c.request("claim", { offerToken: ev.offerToken })) as any;
                    if (timer) clearTimeout(timer);
                    finish(claimed.entry.permitToken);
                  } else if (ev.type === "cancelled" || ev.type === "paused" || ev.type === "reclaimed") {
                    if (timer) clearTimeout(timer);
                    finish(null);
                  }
                }
              } catch {
                /* transient; retry */
              }
              await new Promise((r2) => setTimeout(r2, 200));
            }
          })();
        });
        if (!permit) fail("wait: timed out or the request was cancelled/paused/reclaimed", 69);
        out({ permit_token: permit });
        return;
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
      if (sub === "stop") {
        // Connect and ask... simplest: SIGTERM via daemon.json pid.
        const dir = process.env.LOAD_LOCK_STATE_DIR || join(process.env.HOME ?? "~", ".local", "state", "load-lock");
        try {
          const info = JSON.parse(readFileSync(join(dir, "daemon.json"), "utf8"));
          process.kill(info.pid, "SIGTERM");
          process.stdout.write(`load-lock: daemon (pid ${info.pid}) stopping\n`);
        } catch {
          process.stdout.write("load-lock: no running daemon found\n");
        }
        return;
      }
      if (sub === "start") {
        // Connecting auto-spawns a detached daemon (see shared/client.ts);
        // hello confirms it is up.
        const r = await withClient((c) => c.request("hello", {}));
        process.stdout.write(`load-lock: daemon running on pid ${(r as any).pid} (${process.env.LOAD_LOCK_SOCKET || "default socket"})\n`);
        return;
      }
      // status
      const r = await withClient((c) => c.request("hello", {}));
      out(r, () => `load-lock daemon: pid ${(r as any).pid}, protocol v${(r as any).protocolVersion}, config version ${(r as any).configVersion}`);
      return;
    }

    case "doctor": {
      const report: Record<string, unknown> = {};
      report.node = process.version;
      report.platform = process.platform;
      const dir = process.env.LOAD_LOCK_STATE_DIR || join(homedir(), ".local", "state", "load-lock");
      report.stateDir = dir;
      report.socketExists = existsSync(join(dir, "daemon.sock"));
      report.configExists = existsSync(join(dir, "config.json"));
      report.journalExists = existsSync(join(dir, "journal.json"));
      try {
        report.hello = await withClient((c) => c.request("hello", {}));
        const insp = await withClient((c) => c.request("inspect", {}));
        report.effectiveCores = (insp as any).cpu.effectiveCores;
        report.pressure = (insp as any).pressure.note;
        report.procs = (insp as any).cpu.cgroupVersion;
      } catch (e) {
        report.daemon = `unreachable: ${(e as Error).message}`;
      }
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

    case "agent-guide": {
      const p = join(import.meta.dirname ?? ".", "..", "..", "docs", "AGENT_GUIDE.md");
      process.stdout.write(readFileSync(existsSync(p) ? p : join(import.meta.dirname ?? ".", "..", "..", "docs", "AGENT_GUIDE.md"), "utf8"));
      return;
    }

    default:
      fail(`unknown command "${cmd}". Commands: status, inspect, config, pending, events, acquire, claim, release, cancel, rejoin, mark-started, attach-pid, wait, run, service, doctor, recover, install, uninstall, hook, agent-guide`);
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
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        /* already gone */
      }
      fail(`permit no longer startable (${(err as Error).message}); job not started`, 69);
    }
    const forward = (sig: NodeJS.Signals) => {
      try {
        process.kill(-pgid, sig);
      } catch {
        /* already gone */
      }
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
