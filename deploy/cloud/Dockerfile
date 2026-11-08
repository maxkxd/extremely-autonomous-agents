# An organization's agency in the cloud (docs/hosting-in-the-cloud.md): the
# agency server, Google Chrome for the agents' browser on a virtual display,
# and Claude Code for a Claude plan. Built from the repository root:
#   docker build -f deploy/cloud/Dockerfile .
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xvfb xauth tini git ffmpeg xdotool\
      fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
 && curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
 && apt-get install -y --no-install-recommends /tmp/chrome.deb \
 && rm -rf /tmp/chrome.deb /var/lib/apt/lists/*

# Python and uv: MCP servers the Agency Engineer adds often run with uvx or python,
# as on anyone's computer (integrations/mcp-stdio.ts). npx comes with Node.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv python3-pip \
 && rm -rf /var/lib/apt/lists/* \
 && curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh

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
    EAA_CALLBACK_PORT=5175 \
    EAA_CLOUD_HOST=1 \
    DISPLAY=:99 \
    EAA_BROWSER=/usr/bin/google-chrome-stable \
    EAA_BROWSER_ARGS="--no-sandbox --password-store=basic --disable-dev-shm-usage --renderer-process-limit=6 --disable-site-isolation-trials --disable-features=IsolateOrigins,site-per-process --js-flags=--single-threaded-gc --num-raster-threads=1"

# Nothing listens outside the container: members reach it through the relay,
# over the agency's own outbound connection. Sign-ins (OAuth) come back to the
# member's own app on 5175, the address registered with services, which hands
# them on through the relay: EAA_CALLBACK_PORT, not the host's PORT.
ENTRYPOINT ["/usr/bin/tini", "--", "/bin/sh", "/app/start.sh"]
