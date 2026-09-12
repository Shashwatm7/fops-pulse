# ─────────────────────────────────────────────────────────────
# Stage 1: builder — native deps + Vite build
# build-essential is needed to compile better-sqlite3 and the
# @xenova/transformers native bits, and must NOT reach the runtime image.
# ─────────────────────────────────────────────────────────────
FROM node:22-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# Root deps first — this layer is cached until package-lock.json changes.
COPY package*.json ./
RUN npm ci --fetch-retries 5 --fetch-retry-mintimeout 20000 --fetch-retry-maxtimeout 120000

# Dashboard deps as their own layer, for the same reason.
COPY dashboard/package*.json ./dashboard/
RUN npm --prefix dashboard ci --fetch-retries 5 --fetch-retry-mintimeout 20000 --fetch-retry-maxtimeout 120000

COPY . .

# Build the SPA directly rather than via `npm run build`, whose script does a
# redundant second `npm install` inside dashboard/.
RUN npm --prefix dashboard run build

# Drop devDependencies now that the build is done. Native modules stay
# compiled, so the runtime stage needs no toolchain.
RUN npm prune --omit=dev

# ─────────────────────────────────────────────────────────────
# Stage 2: runtime
# ─────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime

# curl is kept deliberately: it is the container HEALTHCHECK below.
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

ENV NODE_ENV=production
# server.js reads `process.env.PORT || 3001`; Container Apps targetPort must match.
ENV PORT=3001

COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/dashboard/dist ./dashboard/dist
COPY --from=builder /usr/src/app/dashboard/package.json ./dashboard/package.json

# Application source. Kept as explicit COPYs so a stray local file (a dump, a
# .env, a scratch script) cannot silently ride into the image.
COPY package*.json ./
COPY migrations ./migrations
COPY config ./config
COPY services ./services
COPY scripts ./scripts
COPY *.js ./

# Read at runtime by the recommendations CSV export (server.js:2188).
COPY outputs ./outputs

# data-archive.js writes JSON snapshots here. Container Apps gives each replica
# an EPHEMERAL filesystem, so this archive is wiped on every restart and
# redeploy. Created empty on purpose — see README "Ephemeral disk" before
# treating it as durable storage.
RUN mkdir -p data-archive

# express.static resolves dashboard/dist from process.cwd(), so WORKDIR must
# stay /usr/src/app — do not run this image from another directory.
RUN chown -R node:node /usr/src/app
USER node

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD curl -fsS http://127.0.0.1:${PORT}/healthz || exit 1

# migrate.js then server.js, in one process — same contract as package.json
# "start". Safe only because this app is pinned to a single replica; see
# infra/azure/README.md on why.
CMD ["npm", "start"]
