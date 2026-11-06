# An organization's agency in the cloud (docs/hosting-in-the-cloud.md): the
# agency server, Google Chrome for the agents' browser on a virtual display,
# and Claude Code for a Claude plan. Built from the repository root:
#   docker build -f deploy/cloud/Dockerfile .
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xvfb xauth tini git \
      fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
 && curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
 && apt-get install -y --no-install-recommends /tmp/chrome.deb \
 && rm -rf /tmp/chrome.deb /var/lib/apt/lists/*

# Claude Code: agents on a Claude plan run through it, signed in with the plan's
# long-lived token (claude setup-token), connected in the organization's Connectors.
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force

WORKDIR /app/apps/server
COPY apps/server/package.json apps/server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY apps/server ./
COPY deploy/cloud/start.sh /app/start.sh

ENV NODE_ENV=production \
    EAA_DATA_DIR=/data/agency \
    PORT=5185 \
    HOOKS_PORT=5186 \
    EAA_CLOUD_HOST=1 \
    DISPLAY=:99 \
    EAA_BROWSER=/usr/bin/google-chrome-stable \
    EAA_BROWSER_ARGS="--no-sandbox --password-store=basic --disable-dev-shm-usage"

# Nothing listens outside the container: members reach it through the relay,
# over the agency's own outbound connection.
ENTRYPOINT ["/usr/bin/tini", "--", "/bin/sh", "/app/start.sh"]
