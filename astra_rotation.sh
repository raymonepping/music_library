#!/usr/bin/env bash
# astra_rotation.sh
#
# Rotates the Astra DB token using:
#  - Vault AppRole (ROLE_ID / SECRET_ID from .approle.env)
#  - Vault KV (kv/datastax for metadata, kv/astra for ciphertext)
#  - Vault Transit (astra-transit) for encryption
#  - Astra CLI to create the new token
#
# It never writes the new token to disk.
# It keeps the previous ciphertext as ASTRA_DB_TOKEN_PREV so you can roll back.
#
# New in v1.0.4:
#   - Optional .env support
#   - Role and description are configurable via env:
#       ASTRA_ROTATION_ROLE              (default: workshop_admin)
#       ASTRA_TOKEN_DESCRIPTION_PREFIX   (default: music-library-rotation)
#   - --quiet to reduce non essential chatter
#     (tool checks + inventory are suppressed, summary stays)

set -euo pipefail

VERSION="1.0.4"

ENV_FILE="${ENV_FILE:-.env}"
APPROLE_FILE="${APPROLE_FILE:-.approle.env}"
DRY_RUN=false
SCRIPT_DEBUG=false
QUIET=false

# Token creation strategy
USE_ASTRA_CLI=true   # Astra CLI path for now

log() {
  # All human-facing output goes to stderr so command substitution
  # can safely capture machine-only values from stdout.
  printf '%s\n' "$@" >&2
}

vlog() {
  # Verbose log, skipped when QUIET=true
  if $QUIET; then
    return
  fi
  printf '%s\n' "$@" >&2
}

die() {
  printf '❌ %s\n' "$*" >&2
  exit 1
}

have_cmd() { command -v "$1" >/dev/null 2>&1; }

hr() { vlog "----------------------------------------"; }

status_line() {
  # $1 = icon, $2 = label, $3 = detail
  if $QUIET; then
    return
  fi
  printf '%s %-30s %s\n' "$1" "$2" "$3" >&2
}

usage() {
  cat <<EOF
astra_rotation.sh v${VERSION}

Rotates the Astra DB token with:
  - Vault AppRole (from .approle.env)
  - Vault KV (kv/datastax and kv/astra)
  - Vault Transit (astra-transit)
  - Astra CLI

Usage:
  $0 [--dry-run] [--debug] [--approle-file FILE] [--quiet]

Options:
  --dry-run           Do not write anything to Vault. Show actions only.
  --debug             Extra debug output.
  --approle-file FILE File with ROLE_ID and SECRET_ID (default: .approle.env)
  --quiet             Reduce non essential output (tool checks + inventories).
  -h, --help          Show this help text.

Environment (can come from .env):
  VAULT_ADDR                      Vault address (default: http://127.0.0.1:18200)
  VAULT_NAMESPACE                 Optional namespace
  VAULT_KV_MOUNT                  KV v2 mount (default: kv)
  ASTRA_META_PATH                 Metadata path under KV (default: datastax)
  ASTRA_TOKEN_PATH                Token path under KV (default: astra)
  VAULT_TRANSIT_KEY               Transit key (default: astra-transit)

  ASTRA_ROTATION_ROLE             Role used for astra token create
                                  (default: workshop_admin)
  ASTRA_TOKEN_DESCRIPTION_PREFIX  Description prefix for created tokens
                                  (default: music-library-rotation)

EOF
}

# ---------------------------
# Arg parsing
# ---------------------------

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --debug)
      SCRIPT_DEBUG=true
      shift
      ;;
    --quiet)
      QUIET=true
      shift
      ;;
    --approle-file)
      APPROLE_FILE="${2:-}"
      if [[ -z "$APPROLE_FILE" ]]; then
        die "--approle-file requires a value"
      fi
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown argument: $1"
      ;;
  esac
done

# ---------------------------
# Load .env (optional)
# ---------------------------

if [[ -f "$ENV_FILE" ]]; then
  vlog "📦 Loading environment from ${ENV_FILE}"
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
else
  vlog "ℹ️  No ${ENV_FILE} found, using built in defaults for env vars."
fi

# ---------------------------
# Vault layout and defaults
# ---------------------------

VAULT_ADDR="${VAULT_ADDR:-http://127.0.0.1:18200}"
VAULT_NAMESPACE="${VAULT_NAMESPACE:-}"
VAULT_KV_MOUNT="${VAULT_KV_MOUNT:-kv}"
ASTRA_META_PATH="${ASTRA_META_PATH:-datastax}"   # kv/datastax
ASTRA_TOKEN_PATH="${ASTRA_TOKEN_PATH:-astra}"    # kv/astra
VAULT_TRANSIT_KEY="${VAULT_TRANSIT_KEY:-astra-transit}"

ASTRA_DB_TOKEN_KEY="${ASTRA_DB_TOKEN_KEY:-ASTRA_DB_TOKEN}"
ASTRA_DB_TOKEN_PREV_KEY="${ASTRA_DB_TOKEN_PREV_KEY:-ASTRA_DB_TOKEN_PREV}"
ASTRA_DB_APP_TOKEN_KEY="${ASTRA_DB_APP_TOKEN_KEY:-ASTRA_DB_APPLICATION_TOKEN}"
ASTRA_DB_APP_TOKEN_PREV_KEY="${ASTRA_DB_APP_TOKEN_PREV_KEY:-ASTRA_DB_APPLICATION_TOKEN_PREV}"

ASTRA_ROTATION_ROLE="${ASTRA_ROTATION_ROLE:-workshop_admin}"
ASTRA_TOKEN_DESCRIPTION_PREFIX="${ASTRA_TOKEN_DESCRIPTION_PREFIX:-music-library-rotation}"

export VAULT_ADDR
if [[ -n "$VAULT_NAMESPACE" ]]; then
  export VAULT_NAMESPACE
fi

# ---------------------------
# Tool checks
# ---------------------------

if ! have_cmd vault; then
  status_line "🔴" "vault" "vault CLI not found."
  die "Install vault CLI first."
fi

if ! have_cmd jq; then
  status_line "🔴" "jq" "jq not found."
  die "Install jq first."
fi

if ! have_cmd base64; then
  status_line "🔴" "base64" "base64 not found."
  die "Install base64 utility."
fi

if $USE_ASTRA_CLI; then
  if ! have_cmd astra; then
    status_line "🔴" "astra" "Astra CLI not found."
    die "Install Astra CLI or change rotation method."
  fi
fi

if ! $QUIET; then
  log "🔧 Checking required tools..."
  status_line "🟢" "vault" "Found: $(command -v vault)"
  status_line "🟢" "jq" "Found: $(command -v jq)"
  status_line "🟢" "base64" "Found: $(command -v base64)"
  if $USE_ASTRA_CLI; then
    status_line "🟢" "astra" "Found: $(command -v astra)"
  fi
  hr
fi

# ---------------------------
# Load AppRole credentials
# ---------------------------

if [[ ! -f "$APPROLE_FILE" ]]; then
  die "AppRole file '$APPROLE_FILE' not found. Expected ROLE_ID and SECRET_ID."
fi

# shellcheck disable=SC1090
. "$APPROLE_FILE"

ROLE_ID="${ROLE_ID:-}"
SECRET_ID="${SECRET_ID:-}"

if [[ -z "$ROLE_ID" || -z "$SECRET_ID" ]]; then
  die "ROLE_ID or SECRET_ID missing in $APPROLE_FILE"
fi

vlog "🔐 Using AppRole from $APPROLE_FILE"
status_line "🟢" "ROLE_ID" "Loaded from file"
status_line "🟢" "SECRET_ID" "Loaded from file (hidden)"
hr

# ---------------------------
# AppRole login to Vault
# ---------------------------

vlog "🔑 Logging into Vault via AppRole..."

LOGIN_JSON="$(
  vault write -format=json auth/approle/login \
    role_id="$ROLE_ID" \
    secret_id="$SECRET_ID"
)"

VAULT_TOKEN="$(echo "$LOGIN_JSON" | jq -r '.auth.client_token')"
VAULT_TTL="$(echo "$LOGIN_JSON" | jq -r '.auth.lease_duration')"

if [[ -z "$VAULT_TOKEN" || "$VAULT_TOKEN" == "null" ]]; then
  die "Failed to obtain Vault token via AppRole."
fi

status_line "🟢" "Vault token" "Acquired via AppRole (TTL=${VAULT_TTL}s)"
hr

vault_with_token() {
  VAULT_TOKEN="$VAULT_TOKEN" vault "$@"
}

# ---------------------------
# Read Astra metadata
# ---------------------------

vlog "📥 Reading Astra metadata from Vault: ${VAULT_KV_MOUNT}/${ASTRA_META_PATH}"

META_JSON="$(vault_with_token kv get -format=json "${VAULT_KV_MOUNT}/${ASTRA_META_PATH}")"

ASTRA_DB_ID="$(echo "$META_JSON"       | jq -r '.data.data.ASTRA_DB_ID // empty')"
ASTRA_DB_REGION="$(echo "$META_JSON"   | jq -r '.data.data.ASTRA_DB_REGION // empty')"
ASTRA_DB_KEYSPACE="$(echo "$META_JSON" | jq -r '.data.data.ASTRA_DB_KEYSPACE // empty')"
ASTRA_DB_ENDPOINT="$(echo "$META_JSON" | jq -r '.data.data.ASTRA_DB_ENDPOINT // empty')"

if [[ -z "$ASTRA_DB_ID" || -z "$ASTRA_DB_REGION" || -z "$ASTRA_DB_ENDPOINT" ]]; then
  die "Astra metadata in ${VAULT_KV_MOUNT}/${ASTRA_META_PATH} is incomplete (need ID, REGION, ENDPOINT)."
fi

status_line "🟢" "Astra DB ID"       "$ASTRA_DB_ID"
status_line "🟢" "Astra DB region"   "$ASTRA_DB_REGION"
status_line "🟢" "Astra DB endpoint" "$ASTRA_DB_ENDPOINT"
status_line "🟢" "Astra keyspace"    "${ASTRA_DB_KEYSPACE:-<not-set>}"
hr

# ---------------------------
# Read current ciphertext
# ---------------------------

vlog "📥 Reading current Astra token ciphertext from Vault: ${VAULT_KV_MOUNT}/${ASTRA_TOKEN_PATH}"

TOKEN_JSON=""
CURRENT_DB_CIPHER=""
CURRENT_APP_CIPHER=""

if TOKEN_JSON="$(vault_with_token kv get -format=json "${VAULT_KV_MOUNT}/${ASTRA_TOKEN_PATH}" 2>/dev/null)"; then
  CURRENT_DB_CIPHER="$(echo "$TOKEN_JSON"  | jq -r ".data.data.${ASTRA_DB_TOKEN_KEY} // empty")"
  CURRENT_APP_CIPHER="$(echo "$TOKEN_JSON" | jq -r ".data.data.${ASTRA_DB_APP_TOKEN_KEY} // empty")"

  if [[ -n "$CURRENT_DB_CIPHER" ]]; then
    status_line "🟢" "Current DB token" "Ciphertext present (len=${#CURRENT_DB_CIPHER})."
  else
    status_line "🟠" "Current DB token" "No ${ASTRA_DB_TOKEN_KEY} set yet."
  fi

  if [[ -n "$CURRENT_APP_CIPHER" ]]; then
    status_line "🟢" "Current app token" "Ciphertext present (len=${#CURRENT_APP_CIPHER})."
  else
    status_line "⚪" "Current app token" "No ${ASTRA_DB_APP_TOKEN_KEY} set (optional)."
  fi
else
  status_line "🟠" "Token path" "kv/${ASTRA_TOKEN_PATH} does not exist yet. It will be created."
fi
hr

# ---------------------------
# Create new Astra token via CLI
# ---------------------------

create_new_token_with_cli() {
  vlog "🎯 Creating new Astra token via Astra CLI..."
  vlog "   Role:        ${ASTRA_ROTATION_ROLE}"
  vlog "   Description: ${ASTRA_TOKEN_DESCRIPTION_PREFIX} <timestamp>"

  local cli_out
  if ! cli_out="$(
    astra token create \
      --role "${ASTRA_ROTATION_ROLE}" \
      --description "${ASTRA_TOKEN_DESCRIPTION_PREFIX} $(date -Iseconds)" \
      --output json 2>/dev/null
  )"; then
    log "❌ Astra CLI token creation failed. Inspect flags and roles."
    return 1
  fi

  local token_val client_id

  token_val="$(printf '%s\n' "$cli_out" | jq -r '.token // .data.token // empty')"
  client_id="$(printf '%s\n' "$cli_out" | jq -r '.clientId // .data.clientId // empty')"

  if [[ -z "$token_val" || "$token_val" == "null" ]]; then
    log "❌ Unable to parse token from Astra CLI output. Check JSON structure."
    if [[ "$SCRIPT_DEBUG" == "true" ]]; then
      log "🔍 [DEBUG] Raw Astra CLI JSON:"
      printf '%s\n' "$cli_out" >&2
    fi
    return 1
  fi

  if [[ "$SCRIPT_DEBUG" == "true" ]]; then
    vlog "🟢 New token (debug) prefix=${token_val:0:16}..., clientId=${client_id:-unknown}"
  else
    vlog "🟢 New token Generated via Astra CLI (AstraCS:..., clientId=${client_id:-unknown})."
  fi

  printf '%s\n' "$token_val"
}

NEW_TOKEN=""
if $USE_ASTRA_CLI; then
  NEW_TOKEN="$(create_new_token_with_cli || echo "")"
fi

if [[ -z "$NEW_TOKEN" ]]; then
  die "New Astra token could not be obtained. Aborting rotation."
fi

if $SCRIPT_DEBUG; then
  status_line "🟢" "New token" "Generated via Astra CLI (prefix=${NEW_TOKEN:0:16}...)."
else
  status_line "🟢" "New token" "Generated via Astra CLI (AstraCS:...)."
fi
hr

# ---------------------------
# Encrypt new token with Transit
# ---------------------------

vlog "🔐 Encrypting new token with Transit key '${VAULT_TRANSIT_KEY}'..."

PLAINTEXT_B64="$(printf '%s' "$NEW_TOKEN" | base64)"

TRANSIT_URL="${VAULT_ADDR%/}/v1/transit/encrypt/${VAULT_TRANSIT_KEY}"

AUTH_HEADER=("X-Vault-Token: ${VAULT_TOKEN}")
NS_HEADER=()
if [[ -n "$VAULT_NAMESPACE" ]]; then
  NS_HEADER=("X-Vault-Namespace: ${VAULT_NAMESPACE}")
fi

ENCRYPT_BODY="$(jq -n --arg pt "$PLAINTEXT_B64" '{ plaintext: $pt }')"

ENCRYPT_JSON="$(
  curl -sS \
    -H "${AUTH_HEADER[0]}" \
    ${NS_HEADER:+-H "${NS_HEADER[0]}"} \
    -H "Content-Type: application/json" \
    -X POST \
    -d "$ENCRYPT_BODY" \
    "$TRANSIT_URL"
)"

NEW_CIPHER="$(echo "$ENCRYPT_JSON" | jq -r '.data.ciphertext // empty')"

if [[ -z "$NEW_CIPHER" || "$NEW_CIPHER" == "null" ]]; then
  die "Transit encryption failed or response missing .data.ciphertext"
fi

status_line "🟢" "Transit ciphertext" "Obtained (len=${#NEW_CIPHER})."
hr

# ---------------------------
# Write back to Vault KV
# ---------------------------

vlog "📝 Updating Vault KV with new ciphertext (and preserving previous)..."
vlog "   Path: ${VAULT_KV_MOUNT}/${ASTRA_TOKEN_PATH}"

if $DRY_RUN; then
  status_line "🟡" "Dry run" "Would write new ciphertext and move current to *_PREV."
else
  PATCH_DATA="$(
    jq -n \
      --arg new "$NEW_CIPHER" \
      --arg old_db "$CURRENT_DB_CIPHER" \
      --arg old_app "$CURRENT_APP_CIPHER" \
      --arg db_key "$ASTRA_DB_TOKEN_KEY" \
      --arg db_prev "$ASTRA_DB_TOKEN_PREV_KEY" \
      --arg app_key "$ASTRA_DB_APP_TOKEN_KEY" \
      --arg app_prev "$ASTRA_DB_APP_TOKEN_PREV_KEY" \
      '
      {
        ($db_key): $new,
        ($app_key): $new
      }
      +
      (if $old_db != "" then { ($db_prev): $old_db } else {} end)
      +
      (if $old_app != "" then { ($app_prev): $old_app } else {} end)
      '
  )"

  vault_with_token kv patch "${VAULT_KV_MOUNT}/${ASTRA_TOKEN_PATH}" -format=json \
    - <<<"$PATCH_DATA" >/dev/null

  status_line "🟢" "KV write" "New token stored, previous saved in *_PREV."
fi
hr

# ---------------------------
# Update metadata
# ---------------------------

ROTATED_AT="$(date -Iseconds)"
vlog "🧾 Updating metadata in kv/${ASTRA_META_PATH} with rotation timestamp ${ROTATED_AT}..."

if $DRY_RUN; then
  status_line "🟡" "Dry run" "Would write last_rotated_at=${ROTATED_AT}."
else
  META_PATCH="$(jq -n --arg ts "$ROTATED_AT" '{ last_rotated_at: $ts }')"
  vault_with_token kv patch "${VAULT_KV_MOUNT}/${ASTRA_META_PATH}" -format=json \
    - <<<"$META_PATCH" >/dev/null

  status_line "🟢" "Metadata" "last_rotated_at updated."
fi
hr

# ---------------------------
# Optional Astra side inventory
# ---------------------------

if ! $DRY_RUN && have_cmd astra && have_cmd jq && ! $QUIET; then
  log "🔍 Astra token inventory (non secret view):"
  astra token list --output json \
    | jq '.data[] | {clientId, generatedOn, roleNames}' || true
  hr
fi

# ---------------------------
# Summary
# ---------------------------

log "📋 Rotation summary:"
log "  - Astra DB:      $ASTRA_DB_ID ($ASTRA_DB_REGION)"
log "  - KV metadata:   ${VAULT_KV_MOUNT}/${ASTRA_META_PATH}"
log "  - KV token path: ${VAULT_KV_MOUNT}/${ASTRA_TOKEN_PATH}"
log "  - Transit key:   ${VAULT_TRANSIT_KEY}"
log "  - Role:          ${ASTRA_ROTATION_ROLE}"
log "  - Dry run:       $DRY_RUN"
log ""

log "✅ Rotation flow complete."
log "   Suggested next step: ./verify_astra_vault.sh --transit"