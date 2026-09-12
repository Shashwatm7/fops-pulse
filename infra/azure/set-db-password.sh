#!/usr/bin/env bash
# Fetch the fops-postgres admin password from the existing fopsdev-tuning-ui
# container app and write a correct DATABASE_URL into infra/azure/.env.azure.
#
# Run this instead of editing the file by hand: it percent-encodes the password
# so characters like @ : / ? # cannot corrupt the connection string, and it
# never prints the password to the terminal or to shell history.
#
# Usage:  ./infra/azure/set-db-password.sh
set -euo pipefail

export PATH="${PATH}:/c/Program Files/Microsoft SDKs/Azure/CLI2/wbin"

RG=FOps-Dev
SRC_APP=fopsdev-tuning-ui
SECRET_NAME=db-password
PG_HOST=fops-postgres.postgres.database.azure.com
PG_USER=fops_dev_admin
PG_DB=fops_pulse
TARGET=infra/azure/.env.azure

die() { printf '\033[1;31m x  %s\033[0m\n' "$*" >&2; exit 1; }
ok()  { printf '\033[1;32m ok %s\033[0m\n' "$*"; }

[ -f "${TARGET}" ] || die "${TARGET} not found. Run this from the repo root."
command -v az >/dev/null || die "az not on PATH. Open a new terminal after installing Azure CLI."
az account show >/dev/null 2>&1 || die "Not logged in. Run: az login --use-device-code"

echo "Reading secret '${SECRET_NAME}' from ${SRC_APP}..."
PW=$(az containerapp secret show -g "${RG}" -n "${SRC_APP}" \
       --secret-name "${SECRET_NAME}" --query value -o tsv 2>/dev/null) \
  || die "Could not read the secret. Check you have access to ${SRC_APP}."

[ -n "${PW}" ] && [ "${PW}" != "None" ] || die "Secret came back empty."
ok "retrieved (${#PW} characters, not shown)"

# Percent-encode the reserved characters that would otherwise break parsing of
# the userinfo section of the URL. % must be first so it does not double-encode.
ENC=$(printf '%s' "${PW}" \
  | sed -e 's|%|%25|g' -e 's|@|%40|g' -e 's|:|%3A|g' -e 's|/|%2F|g' \
        -e 's|?|%3F|g' -e 's|#|%23|g' -e 's|\[|%5B|g' -e 's|\]|%5D|g')

if [ "${ENC}" != "${PW}" ]; then
  ok "password contained reserved characters - percent-encoded"
fi

# sslmode=no-verify is required: pg 8.21 treats `require` as strict verify-full,
# which Azure's certificate chain fails. This matches the repo's own .env.example.
URL="postgresql://${PG_USER}:${ENC}@${PG_HOST}:5432/${PG_DB}?sslmode=no-verify"

# Rewrite the line without ever echoing the URL.
awk -v u="${URL}" '/^DATABASE_URL=/{print "DATABASE_URL=" u; next} {print}' \
  "${TARGET}" > "${TARGET}.tmp" && mv "${TARGET}.tmp" "${TARGET}"

ok "DATABASE_URL written to ${TARGET}"
echo
echo "Verification (password masked):"
grep '^DATABASE_URL=' "${TARGET}" | sed -E 's|://([^:]+):[^@]+@|://\1:***@|'
echo
echo "Next:  ./infra/azure/deploy.sh"
