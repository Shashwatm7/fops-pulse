#!/usr/bin/env bash
# Set ENTRA_CLIENT_SECRET on the live container apps and turn SSO on.
#
# The value is read with `read -s`, so it is never echoed, never reaches your
# shell history, and never passes through a chat window. It is written to
# infra/azure/.env.azure (gitignored, .gitignore:30) so the next full deploy.sh
# run keeps it, AND pushed straight to the running apps so you do not have to
# wait for an image rebuild.
#
# WHERE TO GET THE VALUE
#   Entra admin centre -> App registrations -> the fops app
#   (client id a1785d36-d81d-4ec9-ad5b-f2ab4ce90031)
#   -> Certificates & secrets -> New client secret -> copy the VALUE column.
#
# Azure shows a client secret's value exactly once, at creation. The existing
# secret (hint PKW, expires 2028-08-24) cannot be read back, so this needs a
# NEW one.
#
# ALSO REQUIRED, in the same app registration -> Authentication -> Redirect URIs:
#   https://fops-pulse.blacksmoke-b7a622bd.eastus2.azurecontainerapps.io/api/auth/entra/callback
#   https://fops-pulse-api.blacksmoke-b7a622bd.eastus2.azurecontainerapps.io/api/auth/entra/callback
# Both hostnames, or sign-in fails with redirect_uri_mismatch on whichever is
# missing.
#
# Usage:  ./infra/azure/set-entra-secret.sh
set -uo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-FOps-Dev}"
APPS=(fops-pulse fops-pulse-api)
TARGET=infra/azure/.env.azure
SECRET_NAME=entra-client-secret

die()  { printf '\033[1;31m x  %s\033[0m\n' "$*" >&2; exit 1; }
log()  { printf '\033[1;36m>> %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m ok %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m !  %s\033[0m\n' "$*"; }

[ -f "${TARGET}" ] || die "${TARGET} not found. Run this from the repo root."
command -v az >/dev/null || die "az CLI not found."

printf 'ENTRA_CLIENT_SECRET\n  paste the secret VALUE (hidden): '
read -rs VALUE
printf '\n'
[ -n "${VALUE}" ] || die "nothing entered - aborted, nothing changed."

# Strip quotes/whitespace a paste may carry.
VALUE="$(printf '%s' "${VALUE}" | sed -E 's/^[[:space:]]*"?//; s/"?[[:space:]]*$//')"

# The old deploy.sh wrote the literal string "unset" for an unconfigured key,
# which made the app report SSO as enabled while handing Entra a bogus secret.
# Refuse to reintroduce that.
[ "${VALUE}" = "unset" ] && die "'unset' is the placeholder bug, not a secret."
[ ${#VALUE} -lt 20 ] && warn "that is only ${#VALUE} chars - Entra secrets are usually ~40. Continuing anyway."

# ── Persist for the next full deploy ─────────────────────────────────────────
if grep -q '^ENTRA_CLIENT_SECRET=' "${TARGET}"; then
    awk -v v="${VALUE}" 'index($0,"ENTRA_CLIENT_SECRET=")==1 {print "ENTRA_CLIENT_SECRET=" v; next} {print}' \
        "${TARGET}" > "${TARGET}.tmp" && mv "${TARGET}.tmp" "${TARGET}"
else
    printf 'ENTRA_CLIENT_SECRET=%s\n' "${VALUE}" >> "${TARGET}"
fi
ok "written to ${TARGET} (${#VALUE} chars)"

# ── Apply to the running apps ────────────────────────────────────────────────
for APP in "${APPS[@]}"; do
    az containerapp show -n "${APP}" -g "${RESOURCE_GROUP}" >/dev/null 2>&1 || {
        warn "${APP} does not exist - skipped"; continue;
    }

    log "${APP}: setting secret"
    az containerapp secret set -g "${RESOURCE_GROUP}" -n "${APP}" \
        --secrets "${SECRET_NAME}=${VALUE}" -o none \
        || die "${APP}: failed to set secret"

    # A secret change alone does NOT roll a revision -- secret VALUES are not
    # part of the Container Apps template, so the running replica keeps the old
    # one. Setting the env var reference with a fresh revision suffix is what
    # actually makes it take effect.
    FQDN=$(az containerapp show -n "${APP}" -g "${RESOURCE_GROUP}" \
        --query properties.configuration.ingress.fqdn -o tsv)

    log "${APP}: wiring ENTRA_CLIENT_SECRET and rolling a revision"
    az containerapp update -g "${RESOURCE_GROUP}" -n "${APP}" \
        --revision-suffix "sso$(date -u +%m%d%H%M%S)" \
        --set-env-vars \
            "ENTRA_CLIENT_SECRET=secretref:${SECRET_NAME}" \
            "ENTRA_REDIRECT_URI=https://${FQDN}/api/auth/entra/callback" \
        -o none \
        || die "${APP}: failed to roll revision"

    ok "${APP}: https://${FQDN}"
done

echo
log "Verifying (SSO reports enabled only once the new revision takes traffic)"
for APP in "${APPS[@]}"; do
    FQDN=$(az containerapp show -n "${APP}" -g "${RESOURCE_GROUP}" \
        --query properties.configuration.ingress.fqdn -o tsv 2>/dev/null) || continue
    printf '  %-16s %s\n' "${APP}" "$(curl -sS --max-time 20 "https://${FQDN}/api/auth/entra/status" 2>&1 | head -c 200)"
done

echo
warn "If either reports enabled:false, give the revision ~60s and re-check:"
echo "   curl -sS https://fops-pulse.blacksmoke-b7a622bd.eastus2.azurecontainerapps.io/api/auth/entra/status"
warn "If sign-in fails with redirect_uri_mismatch, the callback URL above is not"
warn "registered in the Entra app registration -> Authentication -> Redirect URIs."
