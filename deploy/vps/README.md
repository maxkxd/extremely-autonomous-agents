# Many organisations on one server

[docs/hosting-in-the-cloud.md](../../docs/hosting-in-the-cloud.md) runs one
organisation's agency in a container. This folder runs many of them on one
Linux server you rent (Hetzner, DigitalOcean, your own box...), each in its
own container:

- **Its own memory cap.** A busy organisation can't starve the others.
- **Its own folder.** `/srv/eaa/orgs/<org id>/`: `data/` is the container's
  `/data`, `env` holds its settings and vault key, and `settings` its memory
  cap.
- **Its own https address**, `https://<org id>.<domain>`, for members' browser
  links. Caddy sits in front and gets each certificate.

A server costs the same whether it hosts one organisation or ten. For what an
organisation uses: an idle agency is about 175 MB, and each agent run going at
the time adds about 0.8 GB. A 3 GB cap allows about three runs at once.

## Set up a server

On a fresh Ubuntu 24.04 (or Debian 12), as root:

```bash
curl -fsSL https://raw.githubusercontent.com/maxkxd/extremely-autonomous-agents/main/deploy/vps/setup.sh | bash -s -- --domain orgs.example.com --issuer https://api.example.com
```

`--issuer` is the backend's `PUBLIC_URL`: its https address, which hosts get
their org tokens' keys from.

It installs:

- Docker
- a firewall: SSH, http and https only
- automatic security updates, restarting at 04:00 when one needs it
- 4 GB of swap
- this folder's `eaa-org` tool
- Caddy
- a nightly backup at 03:00

It then builds the host image from `deploy/cloud/Dockerfile`. Running it again
keeps what's there.

Then point `*.orgs.example.com` at the server (an A record; on Cloudflare,
**DNS only**, so Caddy can get the certificates).

## Organisations

```bash
eaa-org create <org id> --name "Acme" --owner "Pat Lee"          # waits for a bundle
eaa-org create <org id> --name "Acme" --owner "Pat Lee" --empty  # starts with an empty agency
eaa-org create <org id> --name "Acme" --owner "Pat Lee" --vault-key <key> --bundle org.eaa
```

- **The org id** is the organisation's id in our directory.
- **To move one in from a computer**, follow "Moving an organisation in" in
  docs/hosting-in-the-cloud.md: `scripts/move-org.ts --new-key` prints the
  vault key, and `--to-key <key> --out org.eaa --stop` writes the bundle. Copy
  the bundle up (`scp org.eaa root@server:`), then use the last command above.
  `eaa-org move-in <org id> org.eaa [--replace]` gives a bundle to one that's
  already made.
- **Without `--vault-key`**, a new key is generated. Either way it's in the
  organisation's `env`: keep a copy somewhere safe, since the organisation's
  vault can't be opened without it.

| | |
| --- | --- |
| `eaa-org list` | every organisation, its state, memory cap and use, and the server's free memory |
| `eaa-org logs <id> [-f]` | its log |
| `eaa-org start\|stop\|restart <id>` | |
| `eaa-org memory <id> 4g` | a new memory cap (starts it again) |
| `eaa-org set <id> NAME=value` | change a setting (`NAME=` removes it; starts it again) |
| `eaa-org build` | fetch the newest source and build the image |
| `eaa-org update <id>\|--all` | start them again on the newest image |
| `eaa-org delete <id> [--purge]` | remove it; its folder is kept as `<id>.deleted-<when>` unless `--purge` |
| `eaa-org backup` | back up now |

Starting an organisation again (`update`, `set`, `memory`) closes pages its
agents had waiting on an approval or a CAPTCHA. Check those first.

## Backups

Every night, each organisation is paused for a moment and its folder is
written to `/srv/eaa/backups/<date>/<id>.tar.gz`. Pausing means its databases
are copied whole, not mid-write. Seven days are kept (`BACKUP_DAYS` in
`/srv/eaa/config`).

**Those copies are on the same server.** To survive losing it, also do either:

- turn on the provider's own backups (Hetzner: +20% of the server's price), or
- install rclone, set up an **encrypted** remote (`rclone config`, type
  `crypt`), and set `BACKUP_REMOTE=<remote>:<path>` in `/srv/eaa/config`.
  It must be encrypted because each backup holds the organisation's vault key.

To restore one:

```bash
eaa-org stop <id>
tar -xzf <id>.tar.gz -C /srv/eaa/orgs/<id>
eaa-org update <id>
```

## Updating

```bash
eaa-org build && eaa-org update --all
```

Each image is tagged with its commit as well as `latest`. To go back to one:

```bash
docker tag eaa-host:<commit> eaa-host:latest
eaa-org update --all
```
