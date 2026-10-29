/**
 * The full agent guide: docs/AGENT_GUIDE.md, shipped next to dist/ in every
 * copy of the package (the file `load-lock agent-guide` prints). The MCP
 * `agent_guide` tool (issue #61) returns the same file, so a plugin-only
 * install (no skill, no CLI on PATH) can still reach the detailed guide.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "./version.js";

export function agentGuidePath(): string {
  return join(packageRoot(), "docs", "AGENT_GUIDE.md");
}

/** The guide text; throws when this copy ships without docs/. */
export function agentGuideText(): string {
  return readFileSync(agentGuidePath(), "utf8");
}
