#!/bin/bash
# Host-side: build the harness image and run the Claude Code live verification
# via docker compose (load-lock daemon + LiteLLM translation sidecar + claude).
#
# Requires: docker (sudo), docker/.env with LLM_GATEWAY_API_KEY.
#
# Usage:
#   docker/run-claude-verify.sh            # full run (all phases)
#   PHASES=1 docker/run-claude-verify.sh   # restrict phases (comma list)
set -eu
cd "$(dirname "$0")/.."

if [ ! -f docker/.env ]; then
  echo "docker/.env missing (needs LLM_GATEWAY_API_KEY=...)" >&2
  exit 64
fi

PHASES="${PHASES:-1,2,3}"
export PHASES

echo "== Building load-lock-verify:claude-code image (HARNESS=claude-code) =="
sudo docker build -f docker/Dockerfile.harness \
  --build-arg HARNESS=claude-code \
  -t load-lock-verify:claude-code \
  .

mkdir -p /tmp/opencode/claude-verify-logs
HOST_LOG="/tmp/opencode/claude-verify-logs/run-$(date +%Y%m%d-%H%M%S).log"
echo "== Running compose verification (log: $HOST_LOG) =="

cd docker
set +e
sudo docker compose -f compose-claude-verify.yml \
  --env-file .env \
  up --abort-on-container-exit --exit-code-from claude \
  2>&1 | tee "$HOST_LOG"
RC=${PIPESTATUS[0]}
set -e

# Always try to rescue the in-container artifacts (events.json, pty logs,
# transcripts) for post-mortem, especially on failure.
sudo docker compose -f compose-claude-verify.yml cp claude:/workspace \
  ../verify-artifacts-claude >/dev/null 2>&1 \
  || echo "(note: could not copy artifacts from the claude container)"
sudo docker compose -f compose-claude-verify.yml logs claude \
  > "$HOST_LOG.container" 2>&1 || true
sudo docker compose -f compose-claude-verify.yml down -v >/dev/null 2>&1 || true

echo
if [ "$RC" -eq 0 ]; then
  echo "CLAUDE-VERIFY PASSED (log: $HOST_LOG, artifacts: verify-artifacts-claude/)"
else
  echo "CLAUDE-VERIFY FAILED (exit $RC; log: $HOST_LOG, container log: $HOST_LOG.container, artifacts: verify-artifacts-claude/)"
fi
exit "$RC"
