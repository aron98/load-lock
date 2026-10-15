#!/usr/bin/env node
/**
 * load-lock daemon entrypoint. Normally auto-spawned by the first client
 * that needs it (detached, stdio ignored). Runs until SIGTERM/SIGINT or
 * `load-lock service stop`.
 */
import { Daemon } from "./daemon.js";
import { ProtocolError } from "../shared/protocol.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const stateDir = arg("--state-dir");
const socket = arg("--socket");

const d = new Daemon({ stateDir, socket });
try {
  await d.start();
} catch (err) {
  // E.g. another daemon already owns the socket: auto-spawn races resolve
  // themselves, so exit quietly in that case.
  if (err instanceof ProtocolError && err.code === "denied") {
    process.exit(0);
  }
  process.stderr.write(`load-lock daemon failed to start: ${(err as Error).message}\n`);
  process.exit(1);
}
