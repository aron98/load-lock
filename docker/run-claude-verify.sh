#!/bin/bash
# Host-side: build the harness image and run the Claude Code live verification
# via docker compose (load-lock daemon + LiteLLM translation sidecar + claude).
#
# Requires: docker (plain, or sudo when plain docker cannot reach the daemon;
# override with DOCKER="sudo docker"), docker/.env with LLM_GATEWAY_API_KEY,
# LLM_GATEWAY_BASE_URL and LLM_GATEWAY_MODEL.
#
# Usage:
#   docker/run-claude-verify.sh                 # loose install, all phases
#   PHASES=1 docker/run-claude-verify.sh        # restrict phases (comma list)
#   MODE=plugin docker/run-claude-verify.sh     # plugin mode (#104): image
#       without a global load-lock, plugin from this repo's marketplace;
#       default phases s1,s2,1,2,3,s3 (s* use a stub model, 1-3 the real one)
#
# The stub-model phases alone need no docker/.env:
#   docker/run-model-free-checks.sh
set -eu
cd "$(dirname "$0")/.."
. docker/docker-cmd.sh

if [ ! -f docker/.env ]; then
  echo "docker/.env missing (needs LLM_GATEWAY_API_KEY=...)" >&2
  exit 64
fi

MODE="${MODE:-loose}"
case "$MODE" in
  loose)  IMAGE=load-lock-verify:claude-code;        GLOBAL=1; PHASES="${PHASES:-1,2,3}" ;;
  plugin) IMAGE=load-lock-verify:claude-code-plugin; GLOBAL=0; PHASES="${PHASES:-s1,s2,1,2,3,s3}" ;;
  *) echo "MODE must be loose or plugin, got: $MODE" >&2; exit 64 ;;
esac
export MODE PHASES CLAUDE_IMAGE="$IMAGE"

echo "== Building $IMAGE image (HARNESS=claude-code, LOAD_LOCK_GLOBAL=$GLOBAL) =="
"${DOCKER_CMD[@]}" build -f docker/Dockerfile.harness \
  --build-arg HARNESS=claude-code \
  --build-arg LOAD_LOCK_GLOBAL="$GLOBAL" \
  -t "$IMAGE" \
  .

mkdir -p /tmp/opencode/claude-verify-logs
HOST_LOG="/tmp/opencode/claude-verify-logs/run-$MODE-$(date +%Y%m%d-%H%M%S).log"
ARTIFACTS="verify-artifacts-claude"
[ "$MODE" = plugin ] && ARTIFACTS="verify-artifacts-claude-plugin"
echo "== Running compose verification (mode $MODE, phases $PHASES, log: $HOST_LOG) =="

cd docker
set +e
"${DOCKER_CMD[@]}" compose -f compose-claude-verify.yml \
  --env-file .env \
  up --abort-on-container-exit --exit-code-from claude \
  2>&1 | tee "$HOST_LOG"
RC=${PIPESTATUS[0]}
set -e

# Always try to rescue the in-container artifacts (events.json, pty logs,
# transcripts) for post-mortem, especially on failure.
# docker cp nests into an existing directory, so start from an empty one.
rm -rf "../$ARTIFACTS"
"${DOCKER_CMD[@]}" compose -f compose-claude-verify.yml cp claude:/workspace \
  "../$ARTIFACTS" >/dev/null 2>&1 \
  || echo "(note: could not copy artifacts from the claude container)"
"${DOCKER_CMD[@]}" compose -f compose-claude-verify.yml logs claude \
  > "$HOST_LOG.container" 2>&1 || true
"${DOCKER_CMD[@]}" compose -f compose-claude-verify.yml down -v >/dev/null 2>&1 || true

echo
if [ "$RC" -eq 0 ]; then
  echo "CLAUDE-VERIFY PASSED (mode $MODE; log: $HOST_LOG, artifacts: $ARTIFACTS/)"
else
  echo "CLAUDE-VERIFY FAILED (mode $MODE; exit $RC; log: $HOST_LOG, container log: $HOST_LOG.container, artifacts: $ARTIFACTS/)"
fi
exit "$RC"
