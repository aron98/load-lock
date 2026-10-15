#!/bin/bash
# Host-side: build the harness image and run the Codex CLI verification.
# Requires: docker (sudo), docker/.env with TRUSTEDTOKENS_API_KEY.
set -eu
cd "$(dirname "$0")/.."

if [ ! -f docker/.env ]; then
  echo "docker/.env missing (needs TRUSTEDTOKENS_API_KEY=...)" >&2
  exit 64
fi

sudo docker build -f docker/Dockerfile.harness \
  --build-arg HARNESS=codex \
  -t load-lock-verify:codex \
  .

sudo docker run --rm --init \
  --env-file docker/.env \
  -e CODEX_HOME=/root/.codex \
  load-lock-verify:codex \
  /bin/bash /usr/local/bin/verify-codex.sh
