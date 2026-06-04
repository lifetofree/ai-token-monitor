# Dockerfile
# Local personal tool, not production-deployed (see STATUS.md).
# Image is sized for a single-user dashboard on the same host as the
# RTK history DB (mounted read-only into the container) and is
# intentionally minimal: node:20-slim, system sqlite3 CLI, no build step.

FROM node:20-slim

# sqlite3 CLI is invoked by server.js's execFile('sqlite3', ...) path.
RUN apt-get update \
    && apt-get install -y --no-install-recommends sqlite3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install npm deps first (better layer cache).
COPY package.json package-lock.json* ./
RUN npm install --omit=dev \
    && npm cache clean --force

# Application source.
COPY server.js app.js index.html styles.css favicon.svg ./

# Local-personal-tool posture: bind to loopback only, run as unprivileged
# user. If you ever deploy this beyond a single host, you should be
# reading STATUS.md's "Bottom line" and re-thinking this section.
RUN useradd --create-home --shell /bin/bash --uid 1001 app \
    && chown -R app:app /app
USER app

EXPOSE 3000

# Lightweight healthcheck: GET /api/summary should return 200.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:3000/api/summary', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1));"

CMD ["node", "server.js"]
