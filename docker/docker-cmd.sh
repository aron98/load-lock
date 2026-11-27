# Sourced by docker/run-*.sh: decide how to invoke docker.
#
#   DOCKER="sudo docker" docker/run-claude-verify.sh   # explicit override
#
# Default: plain `docker` when it can reach the daemon (Docker Desktop, a
# user in the docker group, rootless docker), else `sudo docker`.
# Sets the array DOCKER_CMD; call it as "${DOCKER_CMD[@]}" build ...
if [ -n "${DOCKER:-}" ]; then
  read -r -a DOCKER_CMD <<<"$DOCKER"
elif docker info >/dev/null 2>&1; then
  DOCKER_CMD=(docker)
else
  echo "(docker cannot reach the daemon as $(id -un); using sudo docker - set DOCKER=... to override)" >&2
  DOCKER_CMD=(sudo docker)
fi
