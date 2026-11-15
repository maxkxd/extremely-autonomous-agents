#!/bin/sh
# The container's start (Dockerfile): the volume made the agency's, a virtual
# display for the agents' browser, then the agency (scripts/cloud-host.ts) as
# the unprivileged "node" user.
set -e
ROOT="$(dirname "$EAA_DATA_DIR")"
mkdir -p "$ROOT"
# A new volume comes owned by root.
[ "$(stat -c %U "$ROOT")" = node ] || chown -R node:node "$ROOT"
# The video plugins keep their work in ~/VideoStudio and ~/LaunchStudio, and the
# home folder is on the container's disk, which a redeploy wipes. Keep those two
# folders on the volume and link them into the home folder, so the plugins keep
# their ~/ paths. HOME itself stays where it is (Claude Code's and Chrome's
# caches stay off the volume). Quiet when there is nothing to move.
KEEP="$ROOT/keep"
mkdir -p /home/node
for name in VideoStudio LaunchStudio; do
  mkdir -p "$KEEP/$name"
  # A real folder here (not yet a link): move what is in it onto the volume,
  # never over a file already there, and only drop it once the copy worked.
  if [ -d "/home/node/$name" ] && [ ! -L "/home/node/$name" ]; then
    if cp -an "/home/node/$name/." "$KEEP/$name/"; then
      rm -rf "/home/node/$name"
    else
      echo "start.sh: could not move /home/node/$name onto the volume; left as it is" >&2
    fi
  fi
  if [ ! -d "/home/node/$name" ] || [ -L "/home/node/$name" ]; then
    ln -sfn "$KEEP/$name" "/home/node/$name"
    chown -h node:node "/home/node/$name"
  fi
done
chown -R node:node "$KEEP"
rm -f /tmp/.X99-lock
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp -ac >/dev/null 2>&1 &
exec setpriv --reuid=node --regid=node --init-groups env HOME=/home/node node --import tsx scripts/cloud-host.ts
