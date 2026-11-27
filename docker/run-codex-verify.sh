#!/bin/bash
# Host-side: build the harness image and run the Codex CLI verification.
# Requires: docker (plain, or sudo when plain docker cannot reach the daemon;
# override with DOCKER="sudo docker"), docker/.env with TRUSTEDTOKENS_API_KEY.
set -eu
cd "$(dirname "$0")/.."
. docker/docker-cmd.sh

if [ ! -f docker/.env ]; then
  echo "docker/.env missing (needs TRUSTEDTOKENS_API_KEY=...)" >&2
  exit 64
fi

"${DOCKER_CMD[@]}" build -f docker/Dockerfile.harness \
  --build-arg HARNESS=codex \
  -t load-lock-verify:codex \
  .

"${DOCKER_CMD[@]}" run --rm --init \
  --env-file docker/.env \
  -e CODEX_HOME=/root/.codex \
  load-lock-verify:codex \
  /bin/bash /usr/local/bin/verify-codex.sh
