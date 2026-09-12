#!/usr/bin/env bash
# Prompt for API keys and write them into infra/azure/.env.azure.
#
# Use this instead of pasting keys into a chat, a commit, or a shell command.
# Input is read with `read -s` so nothing is echoed to the terminal, and the
# values never enter your shell history. The target file is gitignored
# (.gitignore:30).
#
# Press ENTER at any prompt to leave that key unchanged.
#
# Usage:  ./infra/azure/set-api-keys.sh
set -uo pipefail

TARGET=infra/azure/.env.azure

die() { printf '\033[1;31m x  %s\033[0m\n' "$*" >&2; exit 1; }
ok()  { printf '\033[1;32m ok %s\033[0m\n' "$*"; }
skip(){ printf '\033[1;90m -- %s (unchanged)\033[0m\n' "$*"; }

[ -f "${TARGET}" ] || die "${TARGET} not found. Run this from the repo root."

# Rewrite KEY=... in place without printing the value.
set_key() {
    local key="$1" val="$2"
    if grep -q "^${key}=" "${TARGET}"; then
        awk -v k="${key}" -v v="${val}" \
            'index($0, k "=")==1 {print k "=" v; next} {print}' \
            "${TARGET}" > "${TARGET}.tmp" && mv "${TARGET}.tmp" "${TARGET}"
    else
        printf '%s=%s\n' "${key}" "${val}" >> "${TARGET}"
    fi
}

prompt_key() {
    local key="$1" hint="$2" val=""
    printf '\n%s\n  %s\n  paste value (hidden, ENTER to skip): ' "${key}" "${hint}"
    read -rs val
    printf '\n'
    if [ -z "${val}" ]; then skip "${key}"; return; fi
    # Strip accidental surrounding quotes/whitespace from a paste.
    val="$(printf '%s' "${val}" | sed -E 's/^[[:space:]]*"?//; s/"?[[:space:]]*$//')"
    set_key "${key}" "${val}"
    ok "${key} set (${#val} chars)"
}

echo "Values are hidden as you paste. ENTER skips a key."
echo "Source for all of these: Render dashboard -> fops-pulse-1 -> Environment."

prompt_key OPEN_EXCHANGE_APP_ID "forex. Currently rejected: 'Invalid App ID provided'"
prompt_key WEATHER_API_KEY      "weatherapi.com. Currently missing"
prompt_key GROQ_API_KEY         "LLM planner + deep dive. Single key or comma-separated pool"
prompt_key GEMINI_API_KEY       "embeddings + labeling"
prompt_key ANTHROPIC_API_KEY    "optional, only if LLM_PROVIDER=anthropic"
prompt_key ENTRA_CLIENT_SECRET  "Microsoft SSO. Existing secret hint 'PKW', expires 2028-08-24"

echo
echo "Current state (values masked):"
# The file has CRLF endings, so an "empty" line is actually "KEY=\r". A naive
# `sed 's/^KEY=$/(empty)/'` never matches it and every key misreports as set.
# Strip the \r before measuring length.
awk -F= '/^(OPEN_EXCHANGE_APP_ID|WEATHER_API_KEY|GROQ_API_KEY|GEMINI_API_KEY|ANTHROPIC_API_KEY|ENTRA_CLIENT_SECRET|DATABASE_URL|SESSION_SECRET)=/ {
    k = $1; v = substr($0, length(k) + 2); gsub(/\r/, "", v);
    printf "  %-22s %s\n", k, (length(v) == 0 ? "(empty)" : "***set*** (" length(v) " chars)")
}' "${TARGET}"
echo
echo "Next: tell Claude it is done and it will redeploy."
