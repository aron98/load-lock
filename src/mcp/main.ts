#!/usr/bin/env node
/** load-lock MCP stdio server entrypoint (harness-spawned). */
import { runStdioMcp } from "./server.js";

await runStdioMcp();
