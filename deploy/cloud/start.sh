#!/bin/sh
# The container's start (Dockerfile): the volume made the agency's, then the
# agency (scripts/cloud-host.ts) as the unprivileged "node" user.
set -e
ROOT="$(dirname "$EAA_DATA_DIR")"
mkdir -p "$ROOT"
# Everything on the volume must belong to the agency. A new volume comes owned by
# root, and files an earlier run left as another user (root: a command run by hand in
# the container, an older image) stay theirs, so the agency ("node") can't open them -
# "EACCES ... browser-profiles/1/Default/Preferences" - nor can the disk sweep clear
# them. So this is checked at every start, not only when the volume's top folder
# isn't node's. Quiet when nothing is wrong.
NOT_NODE="$(find "$ROOT" -xdev ! -user node 2>/dev/null | wc -l)"
if [ "$NOT_NODE" -gt 0 ]; then
  find "$ROOT" -xdev ! -user node -exec chown -h node:node {} + 2>/dev/null || echo "start.sh: could not change the owner of some files on $ROOT" >&2
  echo "start.sh: gave $NOT_NODE file(s) and folder(s) on $ROOT back to the agency (they belonged to another user)"
fi
# The video plugins keep their work in ~/VideoStudio and ~/LaunchStudio, and the
# home folder is on the container's disk, which a redeploy wipes. Keep those two
# folders on the volume and link them into the home folder, so the plugins keep
# their ~/ paths. HOME itself stays where it is (Claude Code's caches
# stay off the volume). Quiet when there is nothing to move.
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
exec setpriv --reuid=node --regid=node --init-groups env HOME=/home/node node --import tsx scripts/cloud-host.ts
