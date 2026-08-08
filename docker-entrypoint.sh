#!/bin/sh
# One image, two services.
#
# `SERVICE=attestor` runs the thing that reads email and signs claims.
# `SERVICE=daemon` runs the thing that holds the wallet and submits to chain.
#
# The platform hands us $PORT; each service reads its own variable, so the
# mapping happens here rather than in either service's code.
set -eu

: "${SERVICE:=daemon}"
: "${PORT:=8080}"

# Both bind every interface in a container. Loopback is the right default on a
# laptop and the wrong one behind a load balancer, which is why it is decided
# here and not baked into the services.
export MAILPROOF_ATTESTOR_HOST="${MAILPROOF_ATTESTOR_HOST:-0.0.0.0}"
export MAILPROOF_WEB_HOST="${MAILPROOF_WEB_HOST:-0.0.0.0}"

fail() { echo "mailproof: $1" >&2; exit 1; }

case "$SERVICE" in
  attestor)
    export MAILPROOF_ATTESTOR_PORT="$PORT"
    [ -n "${MAILPROOF_ATTESTOR_SEED:-}" ] \
      || fail "MAILPROOF_ATTESTOR_SEED is unset; refusing to sign with a default key"
    echo "mailproof: attestor on :$PORT"
    exec npx tsx services/attestor/src/server.ts
    ;;
  daemon)
    export MAILPROOF_WEB_PORT="$PORT"
    [ -n "${MIDNIGHT_NETWORK:-}" ] \
      || fail "MIDNIGHT_NETWORK is unset; refusing to guess which chain to spend on"
    echo "mailproof: daemon on :$PORT against $MIDNIGHT_NETWORK"
    exec npx tsx apps/web/server.ts
    ;;
  *)
    fail "SERVICE must be 'attestor' or 'daemon', got '$SERVICE'"
    ;;
esac
