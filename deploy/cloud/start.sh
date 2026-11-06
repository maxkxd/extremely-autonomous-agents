#!/bin/sh
# The container's start (Dockerfile): the volume made the agency's, a virtual
# display for the agents' browser, then the agency (scripts/cloud-host.ts) as
# the unprivileged "node" user.
set -e
ROOT="$(dirname "$EAA_DATA_DIR")"
mkdir -p "$ROOT"
# A new volume comes owned by root.
[ "$(stat -c %U "$ROOT")" = node ] || chown -R node:node "$ROOT"
rm -f /tmp/.X99-lock
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp -ac >/dev/null 2>&1 &
exec setpriv --reuid=node --regid=node --init-groups env HOME=/home/node node --import tsx scripts/cloud-host.ts
