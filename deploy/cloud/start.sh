#!/bin/sh
# The container's start (Dockerfile): the volume made the agency's, then the
# agency (scripts/cloud-host.ts) as the unprivileged "node" user.
set -e
# EAA_DATA_DIR set from Git Bash on Windows arrives as "C:/Program Files/Git/data/agency"
# (Git Bash rewrites a leading "/"): a relative path here, so the volume was never found.
# The Git Bash prefix is taken off; any other Windows path is refused for the default.
# (The same check is in src/data-dir.ts, which scripts/cloud-host.ts uses.)
DEFAULT_DATA_DIR=/data/agency
RAW_DATA_DIR="${EAA_DATA_DIR:-$DEFAULT_DATA_DIR}"
case "$RAW_DATA_DIR" in
  [A-Za-z]:[/\\]* | [A-Za-z]:)
    FIXED="$(printf '%s' "$RAW_DATA_DIR" | sed -E 's#\\#/#g; s#^[A-Za-z]:/Program Files( \(x86\))?/Git(/|$)#/#I')"
    case "$FIXED" in
      /?*)
        case "$FIXED" in
          [A-Za-z]:*) FIXED="" ;;
        esac ;;
      *) FIXED="" ;;
    esac
    if [ -n "$FIXED" ]; then
      echo "start.sh: EAA_DATA_DIR is \"$RAW_DATA_DIR\", a Windows path (Git Bash turns a leading / into its install folder): using \"$FIXED\". Set the variable to \"$FIXED\"." >&2
    else
      FIXED="$DEFAULT_DATA_DIR"
      echo "start.sh: EAA_DATA_DIR is \"$RAW_DATA_DIR\", a Windows path that is not a folder here: using \"$FIXED\". Set the variable to a path inside the container." >&2
    fi
    RAW_DATA_DIR="$FIXED" ;;
esac
export EAA_DATA_DIR="$RAW_DATA_DIR"
ROOT="$(dirname "$EAA_DATA_DIR")"
echo "start.sh: the agency's folder is $EAA_DATA_DIR, on $ROOT"
mkdir -p "$ROOT"
# A new volume comes owned by root.
[ "$(stat -c %U "$ROOT")" = node ] || chown -R node:node "$ROOT"
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
