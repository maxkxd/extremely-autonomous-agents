#!/usr/bin/env bash
# Sets up a server to host organisations, many on one machine
# (deploy/vps/README.md). Run once, as root, on a fresh Ubuntu 24.04 or Debian 12:
#
#   curl -fsSL https://raw.githubusercontent.com/maxkxd/extremely-autonomous-agents/main/deploy/vps/setup.sh | bash -s -- \
#     --domain orgs.example.com --issuer https://api.example.com
#
# Installs Docker, a firewall (SSH, http, https only), automatic security updates,
# swap, the eaa-org tool, Caddy in front of the organisations, and a nightly backup.
# Safe to run again: it keeps settings and organisations that are already there.
set -euo pipefail

ROOT=${EAA_ROOT:-/srv/eaa}
DOMAIN=""
ISSUER=""
REPO="https://github.com/maxkxd/extremely-autonomous-agents.git"
BRANCH="main"
EMAIL=""
SWAP_GB=4

usage() {
  cat <<'EOF'
setup.sh --domain <orgs domain> --issuer <backend https address> [options]

  --domain   each organisation is reached at <its id>.<domain>; point *.<domain> at this server
  --issuer   our backend's https address (EAA_TOKEN_ISSUER): its relay and org tokens
  --repo     the repository to build the host image from (default: the official one)
  --branch   its branch (default: main)
  --email    for the https certificates' expiry notices (optional)
  --swap     GB of swap to add when the machine has none (default 4; 0 for none)
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN=$2; shift 2 ;;
    --issuer) ISSUER=$2; shift 2 ;;
    --repo) REPO=$2; shift 2 ;;
    --branch) BRANCH=$2; shift 2 ;;
    --email) EMAIL=$2; shift 2 ;;
    --swap) SWAP_GB=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[ "$(id -u)" = 0 ] || { echo "Run it as root." >&2; exit 1; }

# Settings from an earlier run are kept unless given again.
if [ -f "$ROOT/config" ]; then
  # shellcheck disable=SC1091
  . "$ROOT/config"
  DOMAIN=${DOMAIN:-$ORGS_DOMAIN}
  ISSUER=${ISSUER:-$EAA_TOKEN_ISSUER}
fi
[ -n "$DOMAIN" ] && [ -n "$ISSUER" ] || { usage >&2; exit 2; }
case "$ISSUER" in https://*) ;; *) echo "--issuer is an https address." >&2; exit 2 ;; esac

export DEBIAN_FRONTEND=noninteractive
echo "== Packages"
apt-get update -q
apt-get install -y -q ca-certificates curl git openssl ufw unattended-upgrades cron
# Security updates install themselves; the machine restarts at 04:00 when one needs it.
cat > /etc/apt/apt.conf.d/52eaa-unattended <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:00";
EOF
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null

if ! command -v docker >/dev/null; then
  echo "== Docker"
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null

echo "== Firewall: SSH, http, https"
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
# Docker publishes ports around ufw; only Caddy publishes any (80, 443), so that's all that's open.

if [ "$SWAP_GB" != 0 ] && ! swapon --show | grep -q .; then
  echo "== ${SWAP_GB} GB swap"
  fallocate -l "${SWAP_GB}G" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== $ROOT"
mkdir -p "$ROOT"/{orgs,backups,caddy/data,caddy/config}
chmod 700 "$ROOT"
cat > "$ROOT/config" <<EOF
# Read by eaa-org (deploy/vps/README.md).
ORGS_DOMAIN=$DOMAIN
EAA_TOKEN_ISSUER=$ISSUER
REPO=$REPO
BRANCH=$BRANCH
CADDY_EMAIL=$EMAIL
# Each organisation's memory cap, unless given when it's made (eaa-org create --memory).
DEFAULT_MEMORY=${DEFAULT_MEMORY:-3g}
# Days of nightly backups kept here.
BACKUP_DAYS=${BACKUP_DAYS:-7}
# Optional: an rclone remote:path the nightly backups are copied to as well (off this machine).
BACKUP_REMOTE=${BACKUP_REMOTE:-}
EOF
chmod 600 "$ROOT/config"

echo "== Source and the eaa-org tool"
if [ -d "$ROOT/src/.git" ]; then
  git -C "$ROOT/src" fetch -q origin "$BRANCH"
  git -C "$ROOT/src" checkout -q -B "$BRANCH" "origin/$BRANCH"
else
  git clone -q --branch "$BRANCH" "$REPO" "$ROOT/src"
fi
install -m 755 "$ROOT/src/deploy/vps/eaa-org" /usr/local/bin/eaa-org

docker network inspect eaa >/dev/null 2>&1 || docker network create eaa >/dev/null

echo "== Caddy (https for each organisation)"
eaa-org caddy

echo "== Nightly backup (03:00)"
cat > /etc/cron.d/eaa-backup <<'EOF'
0 3 * * * root /usr/local/bin/eaa-org backup >> /var/log/eaa-backup.log 2>&1
EOF

echo "== The host image (a few minutes the first time)"
eaa-org build

cat <<EOF

Done. Next:
  1. DNS: *.$DOMAIN -> this server's address (A record; on Cloudflare, DNS only).
  2. eaa-org create <org id> --name "<org name>" --owner "<owner's name>" [--vault-key <key>] [--bundle org.eaa]
  3. eaa-org list
EOF
