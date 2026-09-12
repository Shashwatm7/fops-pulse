#!/usr/bin/env bash
# Diagnose the 28P01 "password authentication failed" that is stopping
# fops-pulse from starting.
#
# Tests, against fops-postgres, the credentials we can actually reach:
#   1. the db-password secret on fopsdev-tuning-ui  (what deploy.sh used)
#   2. the backend-store-uri secret on fopsdev-mlflow (a second, independent
#      copy - if THIS one works, the tuning-ui secret is simply stale)
#
# Prints only PASS/FAIL. Never prints a password.
# Requires Docker (used purely to get a psql client).
set -uo pipefail

export PATH="${PATH}:/c/Program Files/Microsoft SDKs/Azure/CLI2/wbin"

RG=FOps-Dev
HOST=fops-postgres.postgres.database.azure.com
USER=fops_dev_admin
DB=fops_pulse

pass() { printf '\033[1;32m PASS  %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m FAIL  %s\033[0m\n' "$*"; }
info() { printf '\033[1;36m ----  %s\033[0m\n' "$*"; }

command -v docker >/dev/null || { echo "Docker required (provides psql)."; exit 1; }

try_login() {
  local label="$1" pw="$2" user="$3"
  if [ -z "${pw}" ] || [ "${pw}" = "None" ]; then
    fail "${label}: secret is empty or unreadable"
    return 1
  fi
  # PGPASSWORD via env so it never appears in the process list or history.
  if docker run --rm -e PGPASSWORD="${pw}" postgres:16-alpine \
       psql -h "${HOST}" -U "${user}" -d "${DB}" -tAc "select 1" >/dev/null 2>&1; then
    pass "${label}: authenticates as ${user} (${#pw} chars)"
    return 0
  else
    fail "${label}: rejected as ${user} (${#pw} chars)"
    return 1
  fi
}

info "Pulling psql client image (first run only)"
docker pull -q postgres:16-alpine >/dev/null 2>&1 || true

info "Test 1: db-password from fopsdev-tuning-ui"
PW1=$(az containerapp secret show -g "${RG}" -n fopsdev-tuning-ui \
        --secret-name db-password --query value -o tsv 2>/dev/null || echo "")
try_login "tuning-ui db-password" "${PW1}" "${USER}"
R1=$?

info "Test 2: password embedded in fopsdev-mlflow backend-store-uri"
URI=$(az containerapp secret show -g "${RG}" -n fopsdev-mlflow \
        --secret-name backend-store-uri --query value -o tsv 2>/dev/null || echo "")
if [ -n "${URI}" ]; then
  # postgresql://user:pass@host/db  ->  pull out user and pass
  U2=$(printf '%s' "${URI}" | sed -nE 's|^[a-z+]+://([^:]+):.*|\1|p')
  P2=$(printf '%s' "${URI}" | sed -nE 's|^[a-z+]+://[^:]+:([^@]+)@.*|\1|p')
  try_login "mlflow backend-store-uri" "${P2}" "${U2:-$USER}"
  R2=$?
else
  fail "mlflow backend-store-uri: unreadable"
  R2=1
fi

echo
if [ "${R1}" -eq 0 ]; then
  echo "=> The tuning-ui password IS valid. The failure is elsewhere -"
  echo "   most likely the value stored in the fops-pulse secret got mangled."
  echo "   Re-run: ./infra/azure/set-db-password.sh && ./infra/azure/deploy.sh"
elif [ "${R2}" -eq 0 ]; then
  echo "=> The tuning-ui password is STALE, but the mlflow one WORKS."
  echo "   Tell Claude and it will point set-db-password.sh at mlflow instead."
else
  echo "=> BOTH stored passwords are rejected. The admin password on"
  echo "   ${HOST} has been rotated and no copy we can"
  echo "   reach is current. Options:"
  echo "     a) get the current password from whoever manages the server"
  echo "     b) reset it (breaks anything still using the old one):"
  echo "        az postgres flexible-server update -g ${RG} -n fops-postgres --admin-password '<new>'"
fi
