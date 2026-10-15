#!/bin/bash
# load-lock x Claude Code live verification - placeholder until the
# Anthropic-format translation proxy (LiteLLM sidecar) is wired up.
# trustedtokens is OpenAI-compatible only; Claude Code speaks the Anthropic
# /v1/messages protocol, so verification needs the proxy (see docker/README).
echo "verify-claude-code.sh: not yet implemented (needs LiteLLM sidecar)" >&2
exit 70
