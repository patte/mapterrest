#!/usr/bin/env bash
# Deploy the built site to the Bunny Storage zone "mapterrest" via its
# S3-compatible endpoint. Runs the aws CLI via uvx if present, else a local aws.
set -euo pipefail

if command -v uvx >/dev/null 2>&1; then
  AWS=(uvx --from awscli aws)
elif command -v aws >/dev/null 2>&1; then
  AWS=(aws)
else
  echo "error: need 'uvx' or 'aws' on PATH (brew install awscli, or install uv)" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Credentials live in .env.deploy (gitignored). See .env.deploy.example.
ENV_FILE="$ROOT/.env.deploy"
if [ -f "$ENV_FILE" ]; then
  set -a; . "$ENV_FILE"; set +a
fi

: "${BUNNY_STORAGE_ZONE:=mapterrest}"          # = S3 access key / username
: "${BUNNY_STORAGE_PASSWORD:?set BUNNY_STORAGE_PASSWORD in $ENV_FILE}"  # = S3 secret key

ENDPOINT="https://de-s3.storage.bunnycdn.com"

export AWS_ACCESS_KEY_ID="$BUNNY_STORAGE_ZONE"
export AWS_SECRET_ACCESS_KEY="$BUNNY_STORAGE_PASSWORD"
export AWS_DEFAULT_REGION="de"

echo "==> Building"
pnpm --dir "$ROOT" build

# Caching is pull-zone config, not object metadata: the S3 gateway discards uploaded
# Cache-Control (verified — the storage origin serves none, and the CDN stamps the
# zone's max-age on everything). The zone must carry an Edge Rule setting no-cache on
# /index.html, or browsers hold a stale page that names chunks --delete has removed.
echo "==> Syncing dist/ -> s3://$BUNNY_STORAGE_ZONE/"
"${AWS[@]}" s3 sync "$ROOT/dist/" "s3://$BUNNY_STORAGE_ZONE/" \
  --endpoint-url "$ENDPOINT" \
  --delete

# Purge the pull zone so the edges refetch everything from storage. Needs the account
# API key (dashboard → Account → API Key) and the pull zone's numeric id (in its
# dashboard URL). Optional: without them the deploy still lands, the edges just age out.
if [ -n "${BUNNY_API_KEY:-}" ] && [ -n "${BUNNY_PULLZONE_ID:-}" ]; then
  echo "==> Purging Bunny pull zone $BUNNY_PULLZONE_ID"
  curl -fsS -X POST "https://api.bunny.net/pullzone/$BUNNY_PULLZONE_ID/purgeCache" \
    -H "AccessKey: $BUNNY_API_KEY" -H "content-length: 0"
else
  echo "warning: BUNNY_API_KEY / BUNNY_PULLZONE_ID not set in $ENV_FILE — skipping CDN purge" >&2
fi

echo "==> Done"
