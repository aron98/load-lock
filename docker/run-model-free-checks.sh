#!/bin/bash
# Host-side: every container check that needs no model and no key (#104).
#
#   1. clean machine: a fresh stock node image (no load-lock, empty npx
#      cache) runs each ACE artifact's committed command on first use and
#      must end with a running daemon (docker/verify-clean-machine.sh)
#   2. Claude Code plugin mode against a stub Anthropic API: the image
#      without a global load-lock, phases s1,s2,s3 of
#      docker/verify-claude-code.sh (MODE=plugin)
#
# Requires docker (plain, or sudo when plain docker cannot reach the daemon;
# override with DOCKER="sudo docker"). Network access for npm. No docker/.env.
#
# Usage:
#   docker/run-model-free-checks.sh              # both
#   CHECKS=clean docker/run-model-free-checks.sh # just one: clean | plugin
set -eu
cd "$(dirname "$0")/.."
. docker/docker-cmd.sh

CHECKS="${CHECKS:-clean,plugin}"
NODE_IMAGE="${NODE_IMAGE:-node:24-bookworm-slim}"
LOGDIR=/tmp/opencode/model-free-logs
mkdir -p "$LOGDIR"
STAMP=$(date +%Y%m%d-%H%M%S)
RC=0

if [[ ",$CHECKS," == *",clean,"* ]]; then
  echo "== clean-machine check in a fresh $NODE_IMAGE container =="
  "${DOCKER_CMD[@]}" pull -q "$NODE_IMAGE" >/dev/null
  set +e
  "${DOCKER_CMD[@]}" run --rm --init -u node -e HOME=/home/node -w /home/node \
    -v "$PWD:/repo:ro" "$NODE_IMAGE" bash /repo/docker/verify-clean-machine.sh \
    2>&1 | tee "$LOGDIR/clean-$STAMP.log"
  r=${PIPESTATUS[0]}
  set -e
  [ "$r" -eq 0 ] || RC=$r
fi

if [[ ",$CHECKS," == *",plugin,"* ]]; then
  echo "== Claude Code plugin mode (stub model): building load-lock-verify:claude-code-plugin =="
  "${DOCKER_CMD[@]}" build -f docker/Dockerfile.harness \
    --build-arg HARNESS=claude-code --build-arg LOAD_LOCK_GLOBAL=0 \
    -t load-lock-verify:claude-code-plugin .
  rm -rf verify-artifacts-claude-plugin
  NAME="load-lock-plugin-check-$STAMP"
  set +e
  "${DOCKER_CMD[@]}" run --init --name "$NAME" -u node -e HOME=/home/node \
    -e MODE=plugin -e PHASES=s1,s2,s3 \
    load-lock-verify:claude-code-plugin /bin/bash /usr/local/bin/verify-claude-code.sh \
    2>&1 | tee "$LOGDIR/plugin-$STAMP.log"
  r=${PIPESTATUS[0]}
  set -e
  "${DOCKER_CMD[@]}" cp "$NAME:/workspace" verify-artifacts-claude-plugin >/dev/null 2>&1 \
    || echo "(note: could not copy artifacts from the container)"
  "${DOCKER_CMD[@]}" rm -f "$NAME" >/dev/null 2>&1 || true
  [ "$r" -eq 0 ] || RC=$r
fi

echo
grep -h "^RESULT" "$LOGDIR"/*-"$STAMP".log 2>/dev/null || true
if [ "$RC" -eq 0 ]; then
  echo "MODEL-FREE CHECKS PASSED (logs: $LOGDIR/*-$STAMP.log)"
else
  echo "MODEL-FREE CHECKS FAILED (exit $RC; logs: $LOGDIR/*-$STAMP.log)"
fi
exit "$RC"
