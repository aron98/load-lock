/**
 * load-lock harness hook handlers (Claude Code, Codex CLI).
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
                `(op "${ev.entry.opKey}"). It expires in ~${seconds}s. Call your load-lock pending tool now and ` +
                `claim the offer with claim(offer_token), then start your heavy work immediately.`,
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
