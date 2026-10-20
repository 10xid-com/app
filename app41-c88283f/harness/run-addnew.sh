#!/usr/bin/env bash
# Emulated-iPhone evidence for app#41 (Add new product in the top bar) against
# a local production build of /home/claude/10xid-com/app-addnew (`next build
# --webpack`), stand-in store and model (fake-services.mjs), and the disposable
# database on 127.0.0.1:5433. Writes everything to $1 (default ./artifacts-addnew).
set -uo pipefail
HERE=/home/claude/app-login-snapshot/smoke
OUT="${1:-$HERE/artifacts-addnew}"
APP=/home/claude/10xid-com/app-addnew
rm -rf "$OUT" && mkdir -p "$OUT/screens"
cd "$HERE"
source session.env
export PGPASSWORD=ci-owner-local-only NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost

# A clean inventory (the database's other tables, the owner and the session stay).
psql -h 127.0.0.1 -p 5433 -U ci_owner -d portal_ci -qc "set client_min_messages = warning; truncate table inventory_movements, inventory_measurements, inventory_extracted_fields, inventory_extractions, inventory_document_links, inventory_documents, inventory_captures, inventory_containers, inventory_lots, inventory_locations, inventory_product_components, inventory_products, inventory_brands, inventory_businesses, inventory_materials cascade"
rm -rf store && mkdir store

pkill -f "^next-server" 2>/dev/null; pkill -f "^node fake-services.mjs" 2>/dev/null; sleep 1
(setsid env STRICT_S3=0 node fake-services.mjs > "$OUT/stand-ins.log" 2>&1 < /dev/null &)
(cd "$APP" && setsid env NODE_ENV=production PORT=3005 \
  DATABASE_APP_URL=postgresql://portal_app:ci-app-local-only@127.0.0.1:5433/portal_ci \
  PORTAL_HOST=localhost:3005 PRIMARY_HOST=localhost:3006 SESSION_COOKIE_SECURE=false \
  INVENTORY_BUSINESSES="$ORG" INVENTORY_VISION_MODEL=smoke-vision:1b \
  OLLAMA_BASE_URL=http://127.0.0.1:9200 OLLAMA_API_KEY=smoke-key OLLAMA_CLOUD_CLIENT_DATA=true \
  MEDIA_BUCKET_ENDPOINT=http://127.0.0.1:9100 MEDIA_BUCKET_NAME=media MEDIA_BUCKET_PATH_STYLE=true \
  MEDIA_BUCKET_ACCESS_KEY_ID=smoke MEDIA_BUCKET_SECRET_ACCESS_KEY=smoke-secret \
  npx next start -p 3005 > "$OUT/app-server.log" 2>&1 < /dev/null &)
for i in $(seq 1 60); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3005/healthz)" = "200" ] && break
  sleep 0.5
done
echo "app $(curl -s -o /dev/null -w '%{http_code}' http://localhost:3005/healthz) at $(git -C "$APP" rev-parse HEAD), build $(cat "$APP/.next/BUILD_ID")"

DBNOTE="PostgreSQL $(psql -h 127.0.0.1 -p 5433 -U ci_owner -d portal_ci -Atc 'show server_version') with $(psql -h 127.0.0.1 -p 5433 -U ci_owner -d portal_ci -Atc 'select count(*) from drizzle.__drizzle_migrations') login migrations applied, built by rebuild-db.sh from login $(ls -t /home/claude/app-login-snapshot/migrate-*.log | head -1 | sed 's/.*migrate-//; s/\.log$//') + seed; app connects as portal_app (RLS)"
SMOKE_DB_NOTE="$DBNOTE" SMOKE_APP_COMMIT="$(git -C "$APP" rev-parse HEAD)" SMOKE_BUILD_ID="$(cat "$APP/.next/BUILD_ID")" SMOKE_OUT="$OUT" \
  timeout 900 node smoke-addnew.mjs 2>&1 | tee "$OUT/run.log"
status=${PIPESTATUS[0]}

pkill -f "^next-server" 2>/dev/null; pkill -f "^node fake-services.mjs" 2>/dev/null
exit "$status"
