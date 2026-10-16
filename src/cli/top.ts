/**
 * `load-lock top` — portable, zero-dependency full-screen terminal dashboard
 * for the machine-wide budget. Uses the library's own client + protocol
 * (never scrapes CLI output); live updates come from the `watch` event
 * stream, with reconnect + event-cursor resume across daemon restarts.
 *
 * Read-only. The viewer itself is light work — it never acquires a permit.
 */
import { DashboardFeed } from "../dashboard/feed.js";
import { renderFrame } from "../dashboard/frame.js";
import { LLClient } from "../shared/client.js";

export interface TopOptions {
  /** Render one frame and exit (also implied when stdout is not a TTY). */
  once?: boolean;
  /** Local re-render cadence for countdowns (default 500 ms). */
  tickMs?: number;
}

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const ALT_SCREEN = "\x1b[?1049h";
const LEAVE_ALT = "\x1b[?1049l";

export async function topCommand(opts: TopOptions = {}): Promise<void> {
  const once = opts.once || !process.stdout.isTTY;
  const client = new LLClient();
  const feed = new DashboardFeed(client);
  try {
    await feed.start();
    if (once) {
      const frame = renderFrame(feed.view(), process.stdout.columns || 100, 1000);
      process.stdout.write(frame.join("\n") + "\n");
      return;
    }
    await runLive(feed, opts);
  } finally {
    await feed.stop();
  }
}

async function runLive(feed: DashboardFeed, opts: TopOptions): Promise<void> {
  const out = process.stdout;
  const tickMs = Math.max(100, opts.tickMs ?? 500);
  let stopped = false;

  const paint = () => {
    const width = out.columns || 100;
    const height = out.rows || 40;
    const frame = renderFrame(feed.view(), width, Math.max(1, height - 1));
    // Pad to full height so old content never lingers after shrinking.
    while (frame.length < height - 1) frame.push("");
    const body = frame.map((l) => l + "\x1b[K").join("\n");
    out.write(`\x1b[H\x1b[2J${body}\n`);
  };

  // The feed signals change asynchronously; the tick loop below repaints on
  // every tick anyway (cheap string render) so new events and countdowns
  // both appear promptly without a paint storm per event burst.

  out.write(ALT_SCREEN + HIDE_CURSOR);
  out.write("\x1b[H\x1b[2J");
  process.stdin.setRawMode?.(true);
  process.stdin.resume();

  const restore = () => {
    process.stdin.setRawMode?.(false);
    out.write(SHOW_CURSOR + LEAVE_ALT);
  };

  let exiting = false;
  const quit = () => {
    if (exiting) return;
    exiting = true;
    restore();
    stopped = true;
    process.stdin.pause();
  };

  const onKey = (data: Buffer) => {
    const k = data.toString("utf8");
    if (k === "q" || k === "Q" || k === "\x1b" || k === "\x03") quit();
    else if (k === "r" || k === "R") void feed.resync().catch(() => {});
  };
  process.stdin.on("data", onKey);
  const onResize = () => paint();
  out.on("resize", onResize);
  const onSignal = () => {
    quit();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  paint();
  try {
    while (!stopped) {
      await new Promise((r) => setTimeout(r, tickMs));
      if (stopped) continue;
      paint(); // cheap local re-render keeps countdowns ticking and shows new events
    }
  } finally {
    restore();
    process.stdin.removeListener("data", onKey);
    out.removeListener("resize", onResize);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}
