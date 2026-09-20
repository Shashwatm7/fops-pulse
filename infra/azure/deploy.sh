#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Deploy fops-pulse as a new container app in the existing FOps-Dev estate.
#
# Everything except the app itself and its database ALREADY EXISTS and is
# reused. Verified against the live subscription on 2026-09-04:
#
#   environment : managedEnvironment-FOpsDev-b92a   (domain blacksmoke-b7a622bd)
#   resource gp : FOps-Dev                          (East US 2)
#   registry    : fopsdev.azurecr.io                (Standard)
#   postgres    : fops-postgres.postgres.database.azure.com  (PG 18, B2s)
#
# This script CREATES only:
#   - database  fops_pulse            on the existing server
#   - container app  fops-pulse       in the existing environment
#   - image     fopsdev.azurecr.io/fops-pulse:<git-sha>
#
# It does NOT create a registry or a Postgres server, and does not modify
# fops-api, fopsdev-mlflow, fopsdev-tuning-ui, or aca-client-onboarding-prod.
#
# Usage:
#   ./infra/azure/deploy.sh                # full deploy
#   ./infra/azure/deploy.sh --image-only   # rebuild image + roll a revision
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# `az acr build` streams the server-side build log to this console. The Vite
# build prints U+2713 ("check mark"), and on Windows the CLI's Python stack
# writes through a cp1252 stream, which raises UnicodeEncodeError mid-stream.
# az then exits non-zero and `set -e` aborts the deploy - even though the ACR
# build itself is running fine server-side. Forcing UTF-8 on the CLI's stdio
# prevents it. Observed 2026-09-07.
export PYTHONIOENCODING=utf-8
export PYTHONUTF8=1

RESOURCE_GROUP="${RESOURCE_GROUP:-FOps-Dev}"
ENVIRONMENT="${ENVIRONMENT:-managedEnvironment-FOpsDev-b92a}"
APP_NAME="${APP_NAME:-fops-pulse}"
LOCATION="${LOCATION:-eastus2}"

ACR_NAME="${ACR_NAME:-fopsdev}"
PG_SERVER="${PG_SERVER:-fops-postgres}"
PG_ADMIN_USER="${PG_ADMIN_USER:-fops_dev_admin}"
PG_DB="${PG_DB:-fops_pulse}"

IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD)}"
TARGET_PORT=3001
MODE="${1:-}"

log()  { printf '\n\033[1;36m>> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m !  %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m x  %s\033[0m\n' "$*" >&2; exit 1; }

# ── Preflight ────────────────────────────────────────────────────────────────
command -v az >/dev/null || die "Azure CLI not on PATH. Open a NEW terminal after install."
az account show >/dev/null 2>&1 || die "Not logged in. Run: az login --use-device-code"

az extension show --name containerapp >/dev/null 2>&1 \
  || { log "Installing containerapp CLI extension"; az extension add --name containerapp --only-show-errors; }

log "Subscription: $(az account show --query name -o tsv)"

# ── Verify the reused resources exist ────────────────────────────────────────
# Fail loudly rather than silently creating a duplicate estate.
log "Verifying existing resources"

ENV_DOMAIN=$(az containerapp env show -g "${RESOURCE_GROUP}" -n "${ENVIRONMENT}" \
  --query properties.defaultDomain -o tsv 2>/dev/null) \
  || die "Environment ${ENVIRONMENT} not found in ${RESOURCE_GROUP}.
     List them with: az containerapp env list -o table"

ACR_SERVER=$(az acr show -n "${ACR_NAME}" --query loginServer -o tsv 2>/dev/null) \
  || die "Registry ${ACR_NAME} not found. List: az acr list -o table"

PG_HOST=$(az postgres flexible-server show -g "${RESOURCE_GROUP}" -n "${PG_SERVER}" \
  --query fullyQualifiedDomainName -o tsv 2>/dev/null) \
  || die "Postgres server ${PG_SERVER} not found."

echo "   environment : ${ENVIRONMENT}  (${ENV_DOMAIN})"
echo "   registry    : ${ACR_SERVER}"
echo "   postgres    : ${PG_HOST}"
echo "   target URL  : https://${APP_NAME}.${ENV_DOMAIN}"

# The image repository is normally the app name, but a second app serving the
# SAME build (e.g. a dedicated hostname for the composed /api/pages endpoints)
# must reuse the first app's image rather than build its own copy:
#   APP_NAME=fops-pulse-api IMAGE_REPO=fops-pulse SKIP_BUILD=1 ./deploy.sh
IMAGE_REPO="${IMAGE_REPO:-${APP_NAME}}"
IMAGE="${ACR_SERVER}/${IMAGE_REPO}:${IMAGE_TAG}"

# ── Database ─────────────────────────────────────────────────────────────────
# A DEDICATED database on the shared server. fops-pulse migrations create
# generically-named tables (users, session, alerts), which would collide with
# the existing drizzla-* / Drizzla-Prod / mlflow databases if it shared one.
if az postgres flexible-server db show -g "${RESOURCE_GROUP}" -s "${PG_SERVER}" \
     -n "${PG_DB}" >/dev/null 2>&1; then
  log "Database ${PG_DB} already exists - reusing"
else
  log "Creating database ${PG_DB} on ${PG_SERVER}"
  az postgres flexible-server db create \
    -g "${RESOURCE_GROUP}" -s "${PG_SERVER}" --name "${PG_DB}" -o none
fi

# ── pgvector ─────────────────────────────────────────────────────────────────
# migrations/001_init.sql runs CREATE EXTENSION IF NOT EXISTS vector and
# declares vector(768) / vector(384) columns. Flexible Server blocks extensions
# unless named in azure.extensions, which was EMPTY on this server as of
# 2026-09-04 - so migrate.js would fail and the container would crash-loop.
#
# Safe on a shared server: the parameter is dynamic (isDynamicConfig=true,
# requiresRestart=false), so no restart and no interruption to fops-api,
# mlflow, or Drizzla-Prod. Allowlisting only PERMITS the extension; it does not
# load it into any other database.
CURRENT_EXT=$(az postgres flexible-server parameter show \
  -g "${RESOURCE_GROUP}" -s "${PG_SERVER}" --name azure.extensions \
  --query value -o tsv 2>/dev/null || echo "")

if echo ",${CURRENT_EXT}," | grep -q ",vector,"; then
  log "pgvector already allowlisted"
else
  # Preserve anything already allowlisted instead of overwriting it.
  NEW_EXT="vector"
  [ -n "${CURRENT_EXT}" ] && NEW_EXT="${CURRENT_EXT},vector"
  log "Allowlisting pgvector (azure.extensions=${NEW_EXT})"
  az postgres flexible-server parameter set \
    -g "${RESOURCE_GROUP}" -s "${PG_SERVER}" \
    --name azure.extensions --value "${NEW_EXT}" -o none
fi

# ── Build the image in ACR ───────────────────────────────────────────────────
# Server-side build: no local linux/amd64 buildx needed on a Windows host, and
# Container Apps only runs amd64.
# --no-logs is REQUIRED on Windows, not a preference. Streaming the build log
# crashes the CLI: Vite prints U+2713, colorama writes it through the console's
# cp1252 codepage, and the resulting UnicodeEncodeError makes az exit non-zero
# while the ACR build carries on succeeding server-side. PYTHONIOENCODING and
# PYTHONUTF8 do NOT fix it - colorama bypasses them. Observed twice, 2026-09-07.
#
# So: queue the build, then poll ACR for the real status. That also means the
# deploy trusts the registry's verdict rather than the CLI's exit code.
if [ -n "${SKIP_BUILD:-}" ]; then
  log "SKIP_BUILD set - reusing existing ${IMAGE}"
  az acr repository show-tags -n "${ACR_NAME}" --repository "${IMAGE_REPO}" -o tsv 2>/dev/null \
    | grep -qx "${IMAGE_TAG}" \
    || die "${IMAGE} is not in the registry, so it cannot be reused. Re-run without SKIP_BUILD."
else
  log "Queueing build of ${IMAGE} in ACR (takes ~5-10 min)"
  # --no-wait prints the run id only on stderr ("Queued a build with ID: ..."),
  # so --query runId comes back empty and must not be relied on. Queue the
  # build, then read the run id back from the registry.
  az acr build \
    --registry "${ACR_NAME}" \
    --image "${IMAGE_REPO}:${IMAGE_TAG}" \
    --image "${IMAGE_REPO}:latest" \
    --platform linux \
    --file Dockerfile \
    --no-logs --no-wait \
    . || die "Could not queue the ACR build."

  RUN_ID=$(az acr task list-runs -r "${ACR_NAME}" --top 1 --query "[0].runId" -o tsv 2>/dev/null)
  [ -n "${RUN_ID}" ] || die "Build was queued but its run id could not be read back."
  echo "   run id: ${RUN_ID}  (az acr task logs -r ${ACR_NAME} --run-id ${RUN_ID} to inspect)"

  for _ in $(seq 1 60); do
    BSTATUS=$(az acr task show-run -r "${ACR_NAME}" --run-id "${RUN_ID}" --query status -o tsv 2>/dev/null || echo "")
    case "${BSTATUS}" in
      Succeeded) echo "   build succeeded"; break ;;
      Failed|Canceled|Error|Timeout)
        die "ACR build ${BSTATUS}. Inspect with:
     az acr task logs -r ${ACR_NAME} --run-id ${RUN_ID}" ;;
      *) printf '   build %s...\n' "${BSTATUS:-pending}"; sleep 20 ;;
    esac
  done
  [ "${BSTATUS}" = "Succeeded" ] || die "Build did not finish within 20 minutes (last status: ${BSTATUS})."
fi

if [ "${MODE}" = "--image-only" ]; then
  az containerapp show -g "${RESOURCE_GROUP}" -n "${APP_NAME}" >/dev/null 2>&1 \
    || die "App ${APP_NAME} does not exist yet - run without --image-only first."
  log "Rolling new revision"
  az containerapp update -g "${RESOURCE_GROUP}" -n "${APP_NAME}" --image "${IMAGE}" -o none
  FQDN=$(az containerapp show -g "${RESOURCE_GROUP}" -n "${APP_NAME}" \
    --query properties.configuration.ingress.fqdn -o tsv)
  log "Done: https://${FQDN}"
  exit 0
fi

# ── Secrets ──────────────────────────────────────────────────────────────────
SECRETS_FILE="infra/azure/.env.azure"
[ -f "${SECRETS_FILE}" ] || die "Missing ${SECRETS_FILE} - see README step 3."
set -a; . "${SECRETS_FILE}"; set +a

: "${DATABASE_URL:?DATABASE_URL must be set in ${SECRETS_FILE}}"
: "${SESSION_SECRET:?SESSION_SECRET must be set in ${SECRETS_FILE}}"

case "${DATABASE_URL}" in
  *"<password>"*) die "DATABASE_URL in ${SECRETS_FILE} still has the <password> placeholder." ;;
esac

# ── Create or update the app ─────────────────────────────────────────────────
# Registry auth uses "system-environment" - the ENVIRONMENT's managed identity,
# which already holds AcrPull on the fopsdev registry (verified 2026-09-04).
# This is the pattern every other app here uses (fops-api, fopsdev-mlflow).
#
# Do NOT use --registry-identity system (the app's OWN identity): that mints a
# fresh principal with no rights, needs a new AcrPull role assignment, and
# fails outright without Microsoft.Authorization/roleAssignments/write. When it
# fails, `az containerapp create` silently substitutes the k8se/quickstart
# placeholder image and the revision lands in ActivationFailed.
#
# min=max=1 is REQUIRED, not a cost choice. server.js registers five
# setInterval schedulers at module scope, unconditionally (price ticks ~15min,
# logistics ~6h, plus three more). Two replicas double-write them; zero
# replicas stop them and data silently goes stale. Every other app in this
# environment is also 1/1.
if az containerapp show -g "${RESOURCE_GROUP}" -n "${APP_NAME}" >/dev/null 2>&1; then
  log "App ${APP_NAME} exists - updating"
else
  log "Creating container app ${APP_NAME}"
  az containerapp create \
    --name "${APP_NAME}" \
    --resource-group "${RESOURCE_GROUP}" \
    --environment "${ENVIRONMENT}" \
    --image "${IMAGE}" \
    --registry-identity system-environment \
    --registry-server "${ACR_SERVER}" \
    --target-port "${TARGET_PORT}" \
    --ingress external \
    --min-replicas 1 --max-replicas 1 \
    --cpu 1.0 --memory 2.0Gi \
    -o none
fi

# Idempotent, and also REPAIRS an app left with no registry config by a failed
# earlier run - without it, `update --image` cannot pull and the placeholder
# image stays put.
#
# Identity-based pull is attempted first because it avoids putting a shared
# credential in the app. It needs Microsoft.Authorization/roleAssignments/write:
# even with --identity system-environment, the CLI tries to grant AcrPull to the
# app's own principal, which fails with AuthorizationFailed for non-admin users.
# Verified failing for shashwat.malik@drizzla.com on 2026-09-06.
log "Configuring registry pull credentials"
if az containerapp registry set \
     -g "${RESOURCE_GROUP}" -n "${APP_NAME}" \
     --server "${ACR_SERVER}" \
     --identity system-environment \
     -o none 2>/dev/null; then
  echo "   using the environment managed identity"
else
  warn "Identity-based pull needs roleAssignments/write, which this account lacks."
  warn "Falling back to registry admin credentials (admin is already enabled on ${ACR_NAME})."
  ACR_USER=$(az acr credential show -n "${ACR_NAME}" --query username -o tsv) \
    || die "Cannot read ${ACR_NAME} admin credentials. Ask an owner to run:
     az role assignment create --assignee \$(az containerapp show -g ${RESOURCE_GROUP} -n ${APP_NAME} --query identity.principalId -o tsv) \\
       --role AcrPull --scope \$(az acr show -n ${ACR_NAME} --query id -o tsv)"
  ACR_PASS=$(az acr credential show -n "${ACR_NAME}" --query "passwords[0].value" -o tsv)
  az containerapp registry set \
    -g "${RESOURCE_GROUP}" -n "${APP_NAME}" \
    --server "${ACR_SERVER}" \
    --username "${ACR_USER}" \
    --password "${ACR_PASS}" \
    -o none
  echo "   using registry admin credentials"
fi

# ── Secrets and env vars: OMIT what is not configured ────────────────────────
# This used to substitute the literal string "unset" for every empty key
# (groq-api-key="${GROQ_API_KEY:-unset}"). That is worse than useless: the app
# cannot tell "unset" from a real key, so it reports itself as CONFIGURED and
# fails at the provider instead of at startup. Observed 2026-09-12 on the live
# app — /api/health/ai claimed groqKeysConfigured:1 with no Groq key at all,
# and /api/auth/entra/status claimed enabled:true with no client secret, which
# would have sent a user to Microsoft and failed at the callback.
#
# So: a key with no value gets no secret and no env var. "Missing" then reads
# as missing, features disable themselves cleanly, and /api/health/ai tells the
# truth.
SECRET_ARGS=()
ENV_ARGS=()

# Required — the app cannot boot without these.
SECRET_ARGS+=( "database-url=${DATABASE_URL}" )
SECRET_ARGS+=( "session-secret=${SESSION_SECRET}" )
ENV_ARGS+=( "DATABASE_URL=secretref:database-url" )
ENV_ARGS+=( "SESSION_SECRET=secretref:session-secret" )

# Optional — included only when a real value exists.
# $1 env var name, $2 secret name, $3 value
add_optional_secret() {
    local env_name="$1" secret_name="$2" value="$3"
    if [ -n "${value}" ] && [ "${value}" != "unset" ]; then
        SECRET_ARGS+=( "${secret_name}=${value}" )
        ENV_ARGS+=( "${env_name}=secretref:${secret_name}" )
        echo "   ${env_name}: set"
    else
        echo "   ${env_name}: omitted (not configured)"
    fi
}

log "Setting secrets"
add_optional_secret GROQ_API_KEY         groq-api-key         "${GROQ_API_KEY:-}"
add_optional_secret GEMINI_API_KEY       gemini-api-key       "${GEMINI_API_KEY:-}"
add_optional_secret ANTHROPIC_API_KEY    anthropic-api-key    "${ANTHROPIC_API_KEY:-}"
add_optional_secret WEATHER_API_KEY      weather-api-key      "${WEATHER_API_KEY:-}"
add_optional_secret OPEN_EXCHANGE_APP_ID open-exchange-app-id "${OPEN_EXCHANGE_APP_ID:-}"
add_optional_secret EIA_API_KEY          eia-api-key          "${EIA_API_KEY:-}"
add_optional_secret API_KEYS             api-keys             "${API_KEYS:-}"
add_optional_secret OPENAI_API_KEY       openai-api-key       "${OPENAI_API_KEY:-}"
add_optional_secret ENTRA_CLIENT_ID      entra-client-id      "${ENTRA_CLIENT_ID:-}"
add_optional_secret ENTRA_CLIENT_SECRET  entra-client-secret  "${ENTRA_CLIENT_SECRET:-}"

az containerapp secret set -g "${RESOURCE_GROUP}" -n "${APP_NAME}" \
  --secrets "${SECRET_ARGS[@]}" -o none

FQDN=$(az containerapp show -g "${RESOURCE_GROUP}" -n "${APP_NAME}" \
  --query properties.configuration.ingress.fqdn -o tsv)

# ENTRA_REDIRECT_URI is derived from the live FQDN. The value in the repo's
# .env.example still points at fops-pulse-1.onrender.com, which would fail
# with redirect_uri_mismatch.
# --revision-suffix FORCES a new revision every run. Without it, a deploy that
# only changes SECRET VALUES produces no new revision at all: Container Apps
# derives revisions from the template, and secret values are not part of it.
# The old replica keeps the stale secret and keeps failing, while the script
# reports success. Observed 2026-09-06: the DB password was corrected but the
# revision from 15:10 kept using the previous value.
ENV_ARGS+=( "NODE_ENV=production" )
ENV_ARGS+=( "PORT=${TARGET_PORT}" )
ENV_ARGS+=( "ENTRA_REDIRECT_URI=https://${FQDN}/api/auth/entra/callback" )
ENV_ARGS+=( "DB_CONNECT_TIMEOUT_MS=${DB_CONNECT_TIMEOUT_MS:-15000}" )
ENV_ARGS+=( "ENABLE_BACKGROUND_AI=${ENABLE_BACKGROUND_AI:-false}" )
ENV_ARGS+=( "ENABLE_USER_SCANNER=${ENABLE_USER_SCANNER:-false}" )
ENV_ARGS+=( "ENABLE_GEO_SCANNER=${ENABLE_GEO_SCANNER:-false}" )
# Read by server.js; was set on Render, so carry it across or article labeling
# silently stays off after the migration.
ENV_ARGS+=( "ENABLE_ARTICLE_LABELING=${ENABLE_ARTICLE_LABELING:-false}" )
ENV_ARGS+=( "API_KEY_USER_EMAIL=${API_KEY_USER_EMAIL:-}" )
ENV_ARGS+=( "API_RATE_LIMIT_PER_MIN=${API_RATE_LIMIT_PER_MIN:-60}" )
ENV_ARGS+=( "LLM_PROVIDER=${LLM_PROVIDER:-groq}" )
ENV_ARGS+=( "OPENAI_BASE_URL=${OPENAI_BASE_URL:-}" )
ENV_ARGS+=( "OPENAI_MODEL=${OPENAI_MODEL:-}" )

# Entra non-secret settings: same rule. An empty ENTRA_AUTHORITY must be ABSENT,
# not present-and-empty, so entra.js falls back to the workforce /organizations
# authority rather than seeing a blank string.
for pair in \
    "ENTRA_AUTHORITY=${ENTRA_AUTHORITY:-}" \
    "ENTRA_ALLOWED_TENANT_IDS=${ENTRA_ALLOWED_TENANT_IDS:-}" \
    "ENTRA_ALLOWED_EMAIL_DOMAINS=${ENTRA_ALLOWED_EMAIL_DOMAINS:-}" \
    "ENTRA_ADMIN_EMAILS=${ENTRA_ADMIN_EMAILS:-}" ; do
    [ -n "${pair#*=}" ] && ENV_ARGS+=( "${pair}" )
done

REV_SUFFIX="r$(date -u +%m%d%H%M%S)"
log "Setting environment variables (new revision: ${APP_NAME}--${REV_SUFFIX})"

# --replace-env-vars, NOT --set-env-vars. set only adds and updates, so a key
# removed from .env.azure would linger on the app forever — including the old
# "unset" placeholders this change exists to eliminate. replace makes the
# deployed env exactly what this script computed.
#
# Consequence worth knowing: anything added by hand in the portal is wiped on
# the next deploy. That is intentional — .env.azure is the single source of
# truth for this app's configuration.
az containerapp update -g "${RESOURCE_GROUP}" -n "${APP_NAME}" \
  --image "${IMAGE}" \
  --revision-suffix "${REV_SUFFIX}" \
  --min-replicas 1 --max-replicas 1 \
  --replace-env-vars "${ENV_ARGS[@]}" \
  -o none

log "Deployed"
echo "   App:  https://${FQDN}"
echo
echo "   curl -fsS https://${FQDN}/healthz    # process up"
echo "   curl -fsS https://${FQDN}/readyz     # 200 => migrations ran, DB reachable"
echo
echo "   az containerapp logs show -g ${RESOURCE_GROUP} -n ${APP_NAME} --follow"
echo
warn "Manual step: add https://${FQDN}/api/auth/entra/callback"
warn "to the Entra app registration redirect URIs, or SSO sign-in will fail."
