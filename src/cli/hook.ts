/**
 * load-lock harness hook handlers (Claude Code, Codex CLI, Cursor).
 *
 * These are invoked by the harness's hook system with the harness's hook
 * JSON on stdin. They are intentionally fast (one daemon RPC or none) and
 * never fail the harness on daemon unavailability.
 *
 * Verified semantics (docs/COMPATIBILITY.md):
 *  - Claude Code SessionStart: plain-text stdout becomes context; matcher
 *    startup|resume|clear|compact|fork => policy survives compaction.
 *  - Claude Code Stop: {"decision":"block","reason":...} continues Claude
 *    with the reason as a new user prompt (idle wakeup); stop_hook_active
 *    guards against loops.
 *  - Claude Code async hooks (async + asyncRewake): exit code 2 + stderr
 *    wakes Claude with a system reminder — used by await-offer.
 *  - Codex SessionStart/SubagentStart: plain stdout = additionalContext.
 *  - Codex Stop: {"decision":"block","reason":...} continues; async hooks
 *    cannot wake an idle Codex session (documented limitation).
 *  - Cursor Stop (hooks v1, https://cursor.com/docs/hooks): stdin carries
 *    workspace_roots (no cwd) and loop_count; stdout JSON
 *    {"followup_message":...} is auto-submitted as the next user message
 *    (idle wakeup). loop_count > 0 guards against followup loops. Verified
 *    against the official docs only (contract-tested, not live-verified).
 */
import { LLClient } from "../shared/client.js";
import { POLICY_BRIEF } from "../policy/text.js";

interface HookInput {
  session_id?: string;
  cwd?: string;
  source?: string;
  agent_id?: string;
  agent_type?: string;
  stop_hook_active?: boolean;
  hook_event_name?: string;
  // Cursor stop-hook fields (hooks v1)
  conversation_id?: string;
  workspace_roots?: string[];
  loop_count?: number;
}

async function readStdin(): Promise<HookInput> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function machineBrief(): Promise<string> {
  try {
    const c = new LLClient();
    await c.connect();
    try {
      const st = (await c.request("status", {})) as any;
      const parts: string[] = [];
      for (const p of st.pools) {
        parts.push(
          `pool "${p.pool}": ${p.used}/${p.capacity} in use` +
            (p.queue.length ? `, ${p.queue.length} queued` : ""),
        );
      }
      const insp = (await c.request("inspect", {})) as any;
      return `Current machine: ~${insp.cpu.effectiveCores} effective core(s), ${(
        insp.memory.effectiveLimitBytes / 1024 ** 3
      ).toFixed(1)} GiB effective memory; ${insp.pressure.note}\nload-lock now: ${parts.join("; ")}.`;
    } finally {
      c.close();
    }
  } catch {
    return "load-lock daemon is not reachable right now; it will auto-start on your first load-lock tool call. Use the tools per the policy above when doing heavy work.";
  }
}

/**
 * Daemon-side dedupe (issue #54): duplicate hook wiring (loose hooks +
 * plugin, two plugins, ...) fires each hook several times. Only the first
 * caller per (harness, session, event, occurrence) acts. Fails open: no
 * session id, an old daemon without hook_once, or any error => act as before.
 */
async function firstHook(
  c: LLClient,
  harness: string,
  event: string,
  sessionId: string | undefined,
  opts: { occurrence?: string; hold?: boolean } = {},
): Promise<boolean> {
  if (!sessionId) return true;
  try {
    const r = (await c.request("hook_once", { harness, sessionId, event, ...opts })) as { first?: unknown };
    return r.first !== false;
  } catch {
    return true;
  }
}

function claimInstruction(offer: any, seconds: number): string {
  return (
    `load-lock: capacity for "${offer.pool}" is now reserved for you (request ${offer.requestId}, ` +
    `op "${offer.opKey}", reason: ${offer.reason}). Claim it NOW with the load-lock claim tool ` +
    `passing offer_token "${offer.offerToken}" — the reservation expires in ~${seconds}s and passes to the next ` +
    `agent if unused. After claiming, start your heavy work immediately (run_with_permit / attach_pid / mark_started).`
  );
}

export async function hookCommand(rest: string[]): Promise<void> {
  const harness = rest[0];
  const event = rest[1];
  if (!harness || !event) {
    process.exit(0); // never break the harness on invocation mistakes
  }
  const input = await readStdin();
  const cwd = input.cwd || process.cwd();

  switch (`${harness}/${event}`) {
    // ------------------------------------------------------- session starts
    case "claude-code/session-start":
    case "codex/session-start":
    case "codex/subagent-start": {
      // Occurrence = SessionStart source (startup/resume/compact/...): a
      // later compaction must re-inject; duplicates of one firing must not.
      const c = new LLClient();
      let first = true;
      try {
        await c.connect();
        first = await firstHook(c, harness, event, input.session_id, { occurrence: input.source ?? input.agent_id });
      } catch {
        /* daemon down: no dedupe possible; machineBrief explains */
      } finally {
        c.close();
      }
      if (!first) return;
      process.stdout.write(POLICY_BRIEF + "\n\n" + (await machineBrief()) + "\n");
      return;
    }

    // ------------------------------------------------------------- wakeups
    case "claude-code/stop":
    case "codex/stop": {
      if (input.stop_hook_active) {
        return; // we already woke once for this stop; do not loop
      }
      try {
        const c = new LLClient({ spawnDaemon: false });
        await c.connect();
        try {
          const { offers } = (await c.request("offers_for_cwd", { cwd })) as any;
          if (offers.length > 0) {
            const o = offers[0];
            // Occurrence = the offer: each offer is delivered once per session.
            if (!(await firstHook(c, harness, event, input.session_id, { occurrence: o.offerToken }))) return;
            const seconds = Math.max(0, Math.round(((o.offerExpiresAt ?? Date.now()) - Date.now()) / 1000));
            process.stdout.write(
              JSON.stringify({ decision: "block", reason: claimInstruction(o, seconds) }) + "\n",
            );
          }
        } finally {
          c.close();
        }
      } catch {
        /* daemon down: nothing to deliver */
      }
      return;
    }

    // Cursor Stop (hooks v1): {"followup_message":...} is auto-submitted by
    // Cursor as the next user message — the documented loop-style idle
    // wakeup. loop_count counts prior stop-hook followups for this
    // conversation (starts at 0) — Cursor's stop_hook_active equivalent.
    case "cursor/stop": {
      if ((input.loop_count ?? 0) > 0) {
        return; // already woke once for this conversation; do not loop
      }
      const cursorCwd = input.workspace_roots?.[0] || process.cwd();
      try {
        const c = new LLClient({ spawnDaemon: false });
        await c.connect();
        try {
          const { offers } = (await c.request("offers_for_cwd", { cwd: cursorCwd })) as any;
          if (offers.length > 0) {
            const o = offers[0];
            if (!(await firstHook(c, harness, event, input.conversation_id ?? input.session_id, { occurrence: o.offerToken }))) return;
            const seconds = Math.max(0, Math.round(((o.offerExpiresAt ?? Date.now()) - Date.now()) / 1000));
            process.stdout.write(
              JSON.stringify({ followup_message: claimInstruction(o, seconds) }) + "\n",
            );
          }
        } finally {
          c.close();
        }
      } catch {
        /* daemon down: nothing to deliver */
      }
      return;
    }

    // async + asyncRewake watcher (Claude Code only; Codex async hooks cannot
    // wake an idle session — documented).
    case "claude-code/await-offer": {
      const maxWaitMs = Number(process.env.LOAD_LOCK_AWAIT_MS ?? 10 * 60_000);
      const c = new LLClient({ spawnDaemon: false });
      try {
        await c.connect();
      } catch {
        process.exit(0); // daemon down; policy hooks will cover it
      }
      // One live watcher per session: the key is held on this connection
      // and released by the daemon when the watcher exits.
      if (!(await firstHook(c, harness, event, input.session_id, { hold: true }))) {
        c.close();
        process.exit(0);
      }
      let woken = false;
      await new Promise<void>((resolve) => {
        const done = setTimeout(() => {
          c.close();
          resolve();
        }, maxWaitMs);
        void c.watch("*", (ev: any) => {
          if (ev.type === "offered" && ev.entry?.cwd === cwd) {
            woken = true;
            clearTimeout(done);
            const seconds = Math.max(0, Math.round(((ev.entry.offerExpiresAt ?? Date.now()) - Date.now()) / 1000));
            process.stderr.write(
              `load-lock: capacity for "${ev.entry.pool}" was just reserved for a request from this directory ` +
                `(op "${ev.entry.opKey}"). It expires in ~${seconds}s. Call the load-lock pending tool now and ` +
                `claim the offer with the load-lock claim tool (offer_token), then start your heavy work immediately.`,
            );
            c.close();
            resolve();
          }
        });
      });
      process.exit(woken ? 2 : 0); // asyncRewake: exit 2 + stderr wakes Claude
    }

    default:
      process.exit(0);
  }
}
