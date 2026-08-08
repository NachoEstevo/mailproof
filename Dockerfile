# MailProof — attestor and daemon, one image, two commands.
#
# Both services share the whole tree: the daemon needs the compiled circuit and
# the shared packages, the attestor needs the shared packages and the
# allowlist. Two images would mean two builds of the same 21 MB of proving
# keys, so this builds once and `SERVICE` picks which half runs.
#
# Nothing secret is baked in. Every key, seed and secret arrives as an
# environment variable at run time — see `railway.md` for the list.

FROM node:22-bookworm-slim

# tini, so a container stopped by the platform actually stops rather than
# leaving the proving worker to be killed mid-transaction.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first: they change far less often than the source, so this layer
# survives most rebuilds.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# The compiled circuit is committed, so the image needs no Compact toolchain —
# which also means the image cannot silently ship a contract that differs from
# the one whose verifier key is already on chain.
COPY contracts/managed ./contracts/managed
COPY packages ./packages
COPY services ./services
COPY apps/web ./apps/web
COPY apps/extension/manifest.json ./apps/extension/manifest.json
COPY config ./config
COPY src ./src
COPY tsconfig.json ./

# tsx is a dev dependency but is how both entry points run.
RUN npm install --no-save tsx@4

ENV NODE_ENV=production
ENV SERVICE=daemon

# Railway supplies PORT; the daemon reads MAILPROOF_WEB_PORT and the attestor
# reads MAILPROOF_ATTESTOR_PORT, so the entrypoint maps whichever is needed.
EXPOSE 8080

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
