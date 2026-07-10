#!/usr/bin/env bash
# verify_astra_vault.sh
#
# Validates for your music_library / Astra + Vault setup:
# 1) .env presence and Astra secret hygiene
# 2) Vault configuration (VAULT_ADDR / VAULT_TOKEN / VAULT_KV_MOUNT)
# 3) Vault KV content (ASTRA_DB_* keys)
# 4) Alignment between .env and Vault
# 5) Astra connectivity via REST (curl)
# 6) Optional: cqlsh presence (with pyenv + cqlsh-astra auto-install + deps)
#
# Changelog:
#   1.0.1 - Add Transit AstraCS token shape check and make cqlsh failures non blocking
#   1.0.0 - Initial Transit and cqlsh integration
#
# Usage:
#   ./verify_astra_vault.sh
#   ./verify_astra_vault.sh --strict
#   ./verify_astra_vault.sh --require-cqlsh
#
# Optional env:
#   CQLSH_TARBALL=/path/to/cqlsh-VERSION-bin.tar.gz
#   CQLSH_ASTRA_URL=override_download_url

set -euo pipefail

# shellcheck disable=SC2034
VERSION="1.0.1"

ENV_FILE="${ENV_FILE:-.env}"
STRICT=false
REQUIRE_CQLSH=false

RUN_REST=false
SCRIPT_DEBUG=false
TRANSIT_CHECK=false

CQLSH_CMD="${CQLSH_CMD:-cqlsh}"
ASTRA_VAULT_KEY="${ASTRA_VAULT_KEY:-astra}"

CQLSH_ASTRA_URL_DEFAULT="https://downloads.datastax.com/enterprise/cqlsh-astra-20230710-vectortype-bin.tar.gz"
CQLSH_ASTRA_URL="${CQLSH_ASTRA_URL:-$CQLSH_ASTRA_URL_DEFAULT}"

log() { echo "$@"; }

die() {
  printf '❌ %s\n' "$*" >&2
  exit 1
}

have_cmd() { command -v "$1" >/dev/null 2>&1; }

hr() { echo "----------------------------------------"; }

status_line() {
  # $1 = icon, $2 = label, $3 = detail
  printf '%s %-30s %s\n' "$1" "$2" "$3"
}

usage() {
  cat <<EOF
verify_astra_vault.sh v${VERSION}

Checks:
  - .env presence and Astra secret hygiene
  - Vault configuration + KV content
  - Config alignment (.env vs Vault)
  - Astra connectivity via REST (curl)
  - Optional cqlsh presence (with pyenv + cqlsh-astra auto-install + deps)

Usage:
  $0 [--strict] [--require-cqlsh] [--rest] [--debug] [--transit]

Options:
  --strict          Treat any 🔴 finding as exit 1 (hard fail)
  --require-cqlsh   Treat missing cqlsh as 🔴 (hard blocker)
  --rest            Include Astra REST connectivity test
  --debug           Enable verbose debug output (implies --rest)
  --transit         Check Transit setup (+ backend /debug/astra)
  -h, --help        Show this help message

Optional:
  CQLSH_TARBALL=/full/path/to/cqlsh-VERSION-bin.tar.gz
  CQLSH_ASTRA_URL=custom_download_url

EOF
}

# shellcheck disable=SC2034
PYTHON_VERSION_STR=""

# shellcheck disable=SC2034
PYTHON_MAJOR=0

# shellcheck disable=SC2034
PYTHON_MINOR=0

# shellcheck disable=SC2034
PYTHON_COMPAT="unknown"

# ---------------------------
# pyenv + deps for cqlsh
# ---------------------------

ensure_pyenv_python_for_cqlsh() {
  if ! command -v pyenv >/dev/null 2>&1; then
    echo "⚠️  pyenv not found; skipping dedicated Python setup for cqlsh."
    return 0
  fi

  echo "▶ Ensuring Python 3.11.9 via pyenv for cqlsh..."
  if ! pyenv install -s 3.11.9; then
    echo "❌ pyenv install 3.11.9 failed."
    return 1
  fi

  export PYENV_VERSION=3.11.9

  echo "▶ Installing Python dependency for cqlsh (six)..."
  pyenv exec python -m pip install --upgrade pip >/dev/null 2>&1 || true
  pyenv exec python -m pip install six >/dev/null 2>&1 || true
}

create_cqlsh_wrapper() {
  local cqlsh_home="$1" # e.g. /Users/you/.local/opt/cqlsh-astra
  local bin_root="${HOME}/.local/bin"
  local wrapper="${bin_root}/cqlsh"

  mkdir -p "$bin_root"
  rm -f "$wrapper"

  cat >"$wrapper" <<EOF
#!/usr/bin/env bash
# Force cqlsh-astra to run with pyenv Python 3.11.9 (+six)
export PYENV_VERSION=3.11.9
CQLSH_HOME="$cqlsh_home"

cd "\$CQLSH_HOME/bin" || exit 1
exec pyenv exec python dsecqlsh.py "\$@"
EOF

  chmod +x "$wrapper"

  # Make sure this script sees it immediately
  export PATH="${bin_root}:${PATH}"

  if command -v cqlsh >/dev/null 2>&1; then
    echo "✅ cqlsh installed at: $(command -v cqlsh)"
    CQLSH_OK=true
  else
    echo "⚠️  cqlsh wrapper created, but not detected in PATH."
  fi
}

auto_install_cqlsh_from_tarball() {
  local explicit_tarball="${1:-}"
  local tarball

  if [[ -n "$explicit_tarball" ]]; then
    tarball="$explicit_tarball"
  else
    tarball="${CQLSH_TARBALL:-}"
  fi

  if [[ -z "$tarball" ]]; then
    shopt -s nullglob
    local candidates=(cqlsh-*-bin.tar.gz cqlsh-astra-*-bin.tar.gz)
    shopt -u nullglob

    if ((${#candidates[@]} == 0)); then
      echo "⚠️  No cqlsh-*-bin.tar.gz or cqlsh-astra-*-bin.tar.gz tarball found in current directory."
      echo "    Set CQLSH_TARBALL or place the tarball here and rerun."
      return 0
    elif ((${#candidates[@]} > 1)); then
      echo "⚠️  Multiple cqlsh tarballs found:"
      printf '    %s\n' "${candidates[@]}"
      echo "    Set CQLSH_TARBALL to the one you want to use and rerun."
      return 0
    else
      tarball="${candidates[0]}"
    fi
  fi

  if [[ ! -f "$tarball" ]]; then
    echo "❌ Tarball '$tarball' does not exist."
    return 1
  fi

  echo "▶ Using cqlsh tarball: $tarball"

  local install_root="${HOME}/.local/opt"
  mkdir -p "$install_root"

  echo "▶ Extracting into ${install_root}..."
  tar -xzf "$tarball" -C "$install_root"

  # Infer top-level directory
  local top
  top=$(tar -tzf "$tarball" 2>/dev/null | head -1 | cut -d/ -f1 || true)
  if [[ -z "$top" ]]; then
    echo "❌ Unable to detect top-level directory inside tarball."
    return 1
  fi

  local cqlsh_home="${install_root}/${top}"

  if [[ ! -x "${cqlsh_home}/bin/cqlsh" ]]; then
    echo "❌ Expected cqlsh at ${cqlsh_home}/bin/cqlsh, but it is not executable."
    return 1
  fi

  ensure_pyenv_python_for_cqlsh || true
  create_cqlsh_wrapper "$cqlsh_home"
}

download_and_install_cqlsh_astra() {
  local src_root="${HOME}/.local/src"
  mkdir -p "$src_root"

  local tarball="${src_root}/cqlsh-astra-20230710-vectortype-bin.tar.gz"

  echo "▶ Downloading cqlsh-astra from:"
  echo "   ${CQLSH_ASTRA_URL}"
  echo "   -> ${tarball}"
  echo

  if ! curl -fL "${CQLSH_ASTRA_URL}" -o "${tarball}"; then
    echo "❌ Failed to download cqlsh-astra tarball from ${CQLSH_ASTRA_URL}"
    echo "   Check network or URL and try again."
    return 1
  fi

  auto_install_cqlsh_from_tarball "$tarball"
}

maybe_offer_cqlsh_install() {
  echo
  echo "ℹ️  cqlsh is not installed."
  echo -n "👉 Auto-download and install cqlsh-astra now? [y/N] "
  read -r ans_dl || ans_dl=""

  case "$ans_dl" in
  [Yy]*)
    echo
    download_and_install_cqlsh_astra
    ;;
  *)
    echo "ℹ️  Skipping automatic cqlsh-astra install."
    ;;
  esac
}

# ---------------------------
# Arg parsing
# ---------------------------

while [[ $# -gt 0 ]]; do
  case "$1" in
  --strict)
    STRICT=true
    shift
    ;;
  --require-cqlsh | --require-cqlSH)
    REQUIRE_CQLSH=true
    shift
    ;;
  --rest)
    RUN_REST=true
    shift
    ;;
  --debug)
    SCRIPT_DEBUG=true
    RUN_REST=true
    shift
    ;;
  --transit)
    TRANSIT_CHECK=true
    shift
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    die "Unknown argument: $1"
    ;;
  esac
done

# ---------------------------
# Tool checks
# ---------------------------

log "🔧 Checking required tools..."
if ! have_cmd curl; then
  status_line "🔴" "curl" "curl is required but not installed."
  die "curl is mandatory for Vault and Astra checks. Install curl and retry."
else
  status_line "🟢" "curl" "Found: $(command -v curl)"
fi

if have_cmd jq; then
  status_line "🟢" "jq" "Found: $(command -v jq)"
  JQ_OK=true
else
  status_line "🟠" "jq" "jq not found. KV JSON parsing will be limited."
  JQ_OK=false
fi

CQLSH_OK=false
if have_cmd "$CQLSH_CMD"; then
  status_line "🟢" "cqlsh" "Found: $(command -v "$CQLSH_CMD")"
  CQLSH_OK=true
else
  status_line "⚪" "cqlsh" "Not found. cqlsh connectivity test will be skipped."
  maybe_offer_cqlsh_install
  if $REQUIRE_CQLSH; then
    status_line "🔴" "cqlsh required" "cqlsh is required (--require-cqlsh) but not installed."
  fi
fi
hr

ANY_RED=false
ANY_ORANGE=false
mark_red() { ANY_RED=true; }
mark_orange() { ANY_ORANGE=true; }

TRANSIT_TOKEN_OK=false
TRANSIT_DECRYPT_OK=false
DECRYPTED_ASTRA_DB_TOKEN=""

if $REQUIRE_CQLSH && ! $CQLSH_OK; then
  mark_red
fi

# ---------------------------
# .env
# ---------------------------

log "🔍 Checking .env file..."
if [[ -f "$ENV_FILE" ]]; then
  log "✅ Found env file: $ENV_FILE"
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  ENV_PRESENT=true
else
  log "⚠️  No $ENV_FILE found in current directory."
  ENV_PRESENT=false
  mark_orange
fi
hr

ASTRA_DB_ID_IN_ENV="${ASTRA_DB_ID:-}"
ASTRA_DB_REGION_IN_ENV="${ASTRA_DB_REGION:-}"
ASTRA_DB_KEYSPACE_IN_ENV="${ASTRA_DB_KEYSPACE:-}"
ASTRA_DB_TOKEN_IN_ENV="${ASTRA_DB_TOKEN:-}"
ASTRA_DB_ENDPOINT_IN_ENV="${ASTRA_DB_ENDPOINT:-}"

HAS_ID=false
HAS_REGION=false
HAS_KEYSPACE=false
HAS_TOKEN=false
HAS_ENDPOINT=false

[[ -n "$ASTRA_DB_ID_IN_ENV" ]] && HAS_ID=true
[[ -n "$ASTRA_DB_REGION_IN_ENV" ]] && HAS_REGION=true
[[ -n "$ASTRA_DB_KEYSPACE_IN_ENV" ]] && HAS_KEYSPACE=true
[[ -n "$ASTRA_DB_TOKEN_IN_ENV" ]] && HAS_TOKEN=true
[[ -n "$ASTRA_DB_ENDPOINT_IN_ENV" ]] && HAS_ENDPOINT=true

log "📦 Evaluating Astra secret hygiene (.env)..."

if $HAS_TOKEN; then
  status_line "🔴" "ASTRA_DB_TOKEN" "Astra DB token present in .env (must live in Vault)."
  mark_red
fi

if $HAS_ID || $HAS_REGION || $HAS_KEYSPACE || $HAS_ENDPOINT; then
  status_line "🟠" "ASTRA_DB_* config" "Non secret Astra config present in .env (teachable: move into Vault)."
  mark_orange
fi

if ! $HAS_TOKEN && ! $HAS_ID && ! $HAS_REGION && ! $HAS_KEYSPACE && ! $HAS_ENDPOINT; then
  if $ENV_PRESENT; then
    status_line "🟢" "ASTRA_DB_* in .env" "No Astra fields in .env (ideal: everything from Vault)."
  else
    status_line "⚪" "ASTRA_DB_* in .env" "No .env loaded; nothing to inspect."
  fi
fi
hr

# ---------------------------
# Vault env + KV
# ---------------------------

log "🔐 Checking Vault environment..."

VAULT_ADDR="${VAULT_ADDR:-}"
VAULT_TOKEN="${VAULT_TOKEN:-}"
VAULT_KV_MOUNT="${VAULT_KV_MOUNT:-}"

missing_vault_env=()
[[ -z "$VAULT_ADDR" ]] && missing_vault_env+=("VAULT_ADDR")
[[ -z "$VAULT_TOKEN" ]] && missing_vault_env+=("VAULT_TOKEN")
[[ -z "$VAULT_KV_MOUNT" ]] && missing_vault_env+=("VAULT_KV_MOUNT")

VAULT_ENV_OK=true
if [[ ${#missing_vault_env[@]} -gt 0 ]]; then
  status_line "🔴" "Vault env vars" "Missing: ${missing_vault_env[*]}"
  VAULT_ENV_OK=false
  mark_red
else
  status_line "🟢" "Vault env vars" "VAULT_ADDR / VAULT_TOKEN / VAULT_KV_MOUNT present."
fi
hr

VAULT_ASTRA_DB_ID=""
VAULT_ASTRA_DB_REGION=""
VAULT_ASTRA_DB_KEYSPACE=""
VAULT_ASTRA_DB_TOKEN=""
VAULT_ASTRA_DB_ENDPOINT=""
VAULT_ASTRA_SCB_PATH=""

VAULT_KV_OK=false
VAULT_HAS_ASTRA_FIELDS=false

if $VAULT_ENV_OK; then
  log "📥 Retrieving Astra credentials from Vault using curl..."
  local_path="${VAULT_KV_MOUNT#/}/data/${ASTRA_VAULT_KEY}"
  vault_url="${VAULT_ADDR%/}/v1/${local_path}"

  if vault_json_raw=$(curl -sS -H "X-Vault-Token: ${VAULT_TOKEN}" "$vault_url" 2>/dev/null); then
    VAULT_KV_OK=true
    if $JQ_OK; then
      VAULT_ASTRA_DB_ID=$(jq -r '.data.data.ASTRA_DB_ID // empty' <<<"$vault_json_raw" 2>/dev/null || echo "")
      VAULT_ASTRA_DB_REGION=$(jq -r '.data.data.ASTRA_DB_REGION // empty' <<<"$vault_json_raw" 2>/dev/null || echo "")
      VAULT_ASTRA_DB_KEYSPACE=$(jq -r '.data.data.ASTRA_DB_KEYSPACE // empty' <<<"$vault_json_raw" 2>/dev/null || echo "")
      VAULT_ASTRA_DB_TOKEN=$(jq -r '.data.data.ASTRA_DB_TOKEN // empty' <<<"$vault_json_raw" 2>/dev/null || echo "")
      VAULT_ASTRA_DB_ENDPOINT=$(jq -r '.data.data.ASTRA_DB_ENDPOINT // empty' <<<"$vault_json_raw" 2>/dev/null || echo "")
      VAULT_ASTRA_SCB_PATH=$(jq -r '.data.data.ASTRA_SCB_PATH // empty' <<<"$vault_json_raw" 2>/dev/null || echo "")
    else
      status_line "🟠" "Vault KV parse" "jq missing; cannot parse KV JSON cleanly."
      mark_orange
    fi

    if [[ -n "$VAULT_ASTRA_DB_ID" && -n "$VAULT_ASTRA_DB_REGION" &&
      -n "$VAULT_ASTRA_DB_KEYSPACE" && -n "$VAULT_ASTRA_DB_ENDPOINT" ]]; then
      VAULT_HAS_ASTRA_FIELDS=true
      status_line "🟢" "Vault KV fields" "Astra metadata fields present in ${VAULT_KV_MOUNT}/${ASTRA_VAULT_KEY}."
    else
      if $JQ_OK; then
        missing_fields=()
        [[ -z "$VAULT_ASTRA_DB_ID" ]] && missing_fields+=("ASTRA_DB_ID")
        [[ -z "$VAULT_ASTRA_DB_REGION" ]] && missing_fields+=("ASTRA_DB_REGION")
        [[ -z "$VAULT_ASTRA_DB_KEYSPACE" ]] && missing_fields+=("ASTRA_DB_KEYSPACE")
        [[ -z "$VAULT_ASTRA_DB_ENDPOINT" ]] && missing_fields+=("ASTRA_DB_ENDPOINT")
        status_line "🟠" "Vault KV fields" "Missing or empty: ${missing_fields[*]}."
        mark_orange
      fi
    fi

  else
    status_line "🔴" "Vault KV read" "Failed to read ${vault_url} (path or permissions or auth)."
    VAULT_KV_OK=false
    mark_red
  fi
else
  log "⚠️  Skipping Vault KV read (Vault env not OK)."
fi
hr

# ---------------------------
# Transit + backend debug/astra checks
# ---------------------------

BACKEND_BASE_URL="${BACKEND_BASE_URL:-http://localhost:3002}"
VAULT_TRANSIT_KEY="${VAULT_TRANSIT_KEY:-astra-transit}"

if $TRANSIT_CHECK; then
  log "🧪 Checking backend /debug/astra endpoint (Transit-backed tokens)..."

  DEBUG_ICON="⚪"
  DEBUG_DETAIL="Backend /debug/astra not checked."
  debug_url="${BACKEND_BASE_URL%/}/debug/astra"

  if debug_json=$(curl -sS "$debug_url" 2>/dev/null); then
    if $JQ_OK; then
      ASTRA_DEBUG_HAS_APP=$(jq -r '.hasAppToken // false' <<<"$debug_json" 2>/dev/null || echo "false")
      ASTRA_DEBUG_HAS_DB=$(jq -r '.hasDbToken // false' <<<"$debug_json" 2>/dev/null || echo "false")
      ASTRA_DEBUG_APP_LEN=$(jq -r '.appLen // 0' <<<"$debug_json" 2>/dev/null || echo "0")
      ASTRA_DEBUG_DB_LEN=$(jq -r '.dbLen // 0' <<<"$debug_json" 2>/dev/null || echo "0")
      ASTRA_DEBUG_KV_PATH=$(jq -r '.kvPath // empty' <<<"$debug_json" 2>/dev/null || echo "")
      ASTRA_DEBUG_TRANSIT_KEY=$(jq -r '.transitKey // empty' <<<"$debug_json" 2>/dev/null || echo "")

      if [[ "$ASTRA_DEBUG_HAS_APP" == "true" && "$ASTRA_DEBUG_HAS_DB" == "true" ]] &&
        (( ASTRA_DEBUG_APP_LEN > 0 )) && (( ASTRA_DEBUG_DB_LEN > 0 )); then
        DEBUG_ICON="🟢"
        DEBUG_DETAIL="Backend reports Transit tokens loaded (len app=${ASTRA_DEBUG_APP_LEN}, db=${ASTRA_DEBUG_DB_LEN})."
        TRANSIT_TOKEN_OK=true
      else
        DEBUG_ICON="🟠"
        DEBUG_DETAIL="Backend /debug/astra reachable, but tokens not fully loaded."
        mark_orange
      fi

      if $SCRIPT_DEBUG; then
        echo "🔍 [DEBUG] /debug/astra kvPath=${ASTRA_DEBUG_KV_PATH}, transitKey=${ASTRA_DEBUG_TRANSIT_KEY}"
      fi
    else
      DEBUG_ICON="🟠"
      DEBUG_DETAIL="jq missing; /debug/astra reachable but response not parsed."
      mark_orange
      if $SCRIPT_DEBUG; then
        echo "🔍 [DEBUG] Raw /debug/astra body:"
        sed 's/^/   /' <<<"$debug_json"
      fi
    fi
  else
    DEBUG_ICON="🔴"
    DEBUG_DETAIL="Failed to call ${debug_url} (backend not running)."
    mark_red
  fi

  status_line "$DEBUG_ICON" "backend /debug/astra" "$DEBUG_DETAIL"
  hr

  # Transit key check via Vault HTTP API
  log "🔐 Checking Vault Transit key '${VAULT_TRANSIT_KEY}'..."

  TRANSIT_ICON="⚪"
  TRANSIT_DETAIL="Transit key not checked."

  if $VAULT_ENV_OK; then
    transit_url="${VAULT_ADDR%/}/v1/transit/keys/${VAULT_TRANSIT_KEY}"

    if transit_json=$(curl -sS -H "X-Vault-Token: ${VAULT_TOKEN}" "$transit_url" 2>/dev/null); then
      if $JQ_OK; then
        TRANSIT_TYPE=$(jq -r '.data.type // "unknown"' <<<"$transit_json" 2>/dev/null || echo "unknown")
        TRANSIT_LATEST=$(jq -r '.data.latest_version // 0' <<<"$transit_json" 2>/dev/null || echo "0")
        TRANSIT_ICON="🟢"
        TRANSIT_DETAIL="Transit key exists (type=${TRANSIT_TYPE}, latest_version=${TRANSIT_LATEST})."
      else
        TRANSIT_ICON="🟢"
        TRANSIT_DETAIL="Transit key readable (jq missing for detailed parse)."
      fi
    else
      TRANSIT_ICON="🔴"
      TRANSIT_DETAIL="Transit key '${VAULT_TRANSIT_KEY}' not readable (path or permissions)."
      mark_red
    fi
  else
    TRANSIT_ICON="🟠"
    TRANSIT_DETAIL="Skipping Transit key check (Vault env not OK)."
    mark_orange
  fi

  status_line "$TRANSIT_ICON" "Transit key" "$TRANSIT_DETAIL"

  # KV ciphertext and Transit decrypt in kv/astra
  if $VAULT_ENV_OK && $JQ_OK; then
    cipher_path="${VAULT_KV_MOUNT#/}/data/astra"
    cipher_url="${VAULT_ADDR%/}/v1/${cipher_path}"

    if vault_cipher_json=$(curl -sS -H "X-Vault-Token: ${VAULT_TOKEN}" "$cipher_url" 2>/dev/null); then
      VAULT_APP_CIPHER=$(jq -r '.data.data.ASTRA_DB_APPLICATION_TOKEN // empty' <<<"$vault_cipher_json" 2>/dev/null || echo "")
      VAULT_DB_CIPHER=$(jq -r '.data.data.ASTRA_DB_TOKEN // empty' <<<"$vault_cipher_json" 2>/dev/null || echo "")

      if [[ "$VAULT_APP_CIPHER" == vault:v* && "$VAULT_DB_CIPHER" == vault:v* ]]; then
        status_line "🟢" "KV ciphertext" "Transit ciphertext present in ${VAULT_KV_MOUNT}/astra."
      else
        status_line "🟠" "KV ciphertext" "kv/astra reachable, but ASTRA_DB_* do not look like Transit ciphertext (vault:v...)."
        mark_orange
      fi

      # Try Transit decrypt of ASTRA_DB_TOKEN ciphertext from kv/astra
      if [[ "$VAULT_DB_CIPHER" == vault:v* ]]; then
        if ! have_cmd base64; then
          status_line "🟠" "Transit decrypt" "base64 not found; cannot decode Transit plaintext."
          mark_orange
        else
          decrypt_url="${VAULT_ADDR%/}/v1/transit/decrypt/${VAULT_TRANSIT_KEY}"
          decrypt_body=$(jq -n --arg ct "$VAULT_DB_CIPHER" '{ciphertext:$ct}')

          if decrypt_json=$(curl -sS \
            -H "X-Vault-Token: ${VAULT_TOKEN}" \
            -H "Content-Type: application/json" \
            -X POST \
            -d "$decrypt_body" \
            "$decrypt_url" 2>/dev/null); then

            PLAINTEXT_B64=$(jq -r '.data.plaintext // empty' <<<"$decrypt_json" 2>/dev/null || echo "")

            if [[ -n "$PLAINTEXT_B64" ]]; then
              DECRYPTED_ASTRA_DB_TOKEN="$(
                printf '%s' "$PLAINTEXT_B64" | base64 --decode 2>/dev/null || echo ""
              )"

              if [[ -n "$DECRYPTED_ASTRA_DB_TOKEN" ]]; then
                TRANSIT_DECRYPT_OK=true
                status_line "🟢" "Transit decrypt" "Successfully decrypted ASTRA_DB_TOKEN via Transit (len=${#DECRYPTED_ASTRA_DB_TOKEN})."

                # New: shape check that plaintext looks like an Astra token
                if [[ "$DECRYPTED_ASTRA_DB_TOKEN" == AstraCS:* ]]; then
                  if $SCRIPT_DEBUG; then
                    echo "🔍 [DEBUG] Astra token prefix: ${DECRYPTED_ASTRA_DB_TOKEN:0:16}..."
                  fi
                else
                  status_line "🟠" "Transit token shape" "Plaintext does not start with AstraCS:. Verify rotation logic."
                  mark_orange
                  if $SCRIPT_DEBUG; then
                    echo "🔍 [DEBUG] Suspicious plaintext from Transit (first 32 chars):"
                    printf '   %s\n' "${DECRYPTED_ASTRA_DB_TOKEN:0:32}"
                  fi
                fi
              else
                status_line "🟠" "Transit decrypt" "Plaintext decode failed for ASTRA_DB_TOKEN."
                mark_orange
              fi
            else
              status_line "🟠" "Transit decrypt" "Transit response missing .data.plaintext for ASTRA_DB_TOKEN."
              mark_orange
            fi
          else
            status_line "🔴" "Transit decrypt" "Failed to call transit/decrypt for '${VAULT_TRANSIT_KEY}'."
            mark_red
          fi
        fi
      fi
    else
      status_line "🟠" "KV ciphertext" "Unable to read ${VAULT_KV_MOUNT}/astra for ciphertext check."
      mark_orange
    fi
  fi

  hr
fi

# ---------------------------
# Config alignment
# ---------------------------

log "🧮 Checking config alignment (.env vs Vault)..."

EFFECTIVE_ASTRA_DB_ID="${VAULT_ASTRA_DB_ID:-$ASTRA_DB_ID_IN_ENV}"
EFFECTIVE_ASTRA_DB_REGION="${VAULT_ASTRA_DB_REGION:-$ASTRA_DB_REGION_IN_ENV}"
EFFECTIVE_ASTRA_DB_KEYSPACE="${VAULT_ASTRA_DB_KEYSPACE:-$ASTRA_DB_KEYSPACE_IN_ENV}"
EFFECTIVE_ASTRA_DB_TOKEN="${VAULT_ASTRA_DB_TOKEN:-$ASTRA_DB_TOKEN_IN_ENV}"
EFFECTIVE_ASTRA_DB_ENDPOINT="${VAULT_ASTRA_DB_ENDPOINT:-$ASTRA_DB_ENDPOINT_IN_ENV}"
EFFECTIVE_ASTRA_SCB_PATH="${VAULT_ASTRA_SCB_PATH:-${ASTRA_SCB_PATH:-}}"

if [[ -n "$ASTRA_DB_REGION_IN_ENV" && -n "$VAULT_ASTRA_DB_REGION" && "$ASTRA_DB_REGION_IN_ENV" != "$VAULT_ASTRA_DB_REGION" ]]; then
  status_line "🟠" "Config drift" ".env region (${ASTRA_DB_REGION_IN_ENV}) != Vault region (${VAULT_ASTRA_DB_REGION})."
  mark_orange
else
  status_line "🟢" "Config drift" "Astra region aligned or single source (env or Vault)."
fi

token_or_transit_ok=false
if [[ -n "$EFFECTIVE_ASTRA_DB_TOKEN" || $TRANSIT_TOKEN_OK == true ]]; then
  token_or_transit_ok=true
fi

if [[ -n "$EFFECTIVE_ASTRA_DB_ID" && -n "$EFFECTIVE_ASTRA_DB_REGION" &&
  -n "$EFFECTIVE_ASTRA_DB_KEYSPACE" && -n "$EFFECTIVE_ASTRA_DB_ENDPOINT" &&
  $token_or_transit_ok == true ]]; then
  status_line "🟢" "Effective config" "Astra metadata present; token supplied via Env/KV or Transit-backed backend."
else
  status_line "🟠" "Effective config" "Effective Astra config incomplete (metadata or token or Transit missing)."
  mark_orange
fi

hr

# ---------------------------
# SCB path resolution
# ---------------------------

resolve_bundle_path() {
  local raw="$1"

  if [[ -z "$raw" ]]; then
    echo ""
    return
  fi

  # Absolute path -> keep as-is
  if [[ "$raw" = /* ]]; then
    echo "$raw"
    return
  fi

  # Base directory is where the script is run from
  local base_dir="$PWD"

  # Case 1: file exists as given (relative)
  if [[ -f "$raw" ]]; then
    echo "${base_dir}/${raw}"
    return
  fi

  # Case 2: common case -> running from repo root, bundle lives in backend/
  if [[ -f "backend/$raw" ]]; then
    echo "${base_dir}/backend/${raw}"
    return
  fi

  # Fallback: still turn it into an absolute path so cqlsh does not depend on CWD
  echo "${base_dir}/${raw}"
}

EFFECTIVE_ASTRA_SCB_PATH_RESOLVED="$(resolve_bundle_path "$EFFECTIVE_ASTRA_SCB_PATH")"

if $SCRIPT_DEBUG; then
  echo "🔍 [DEBUG] SCB raw:      ${EFFECTIVE_ASTRA_SCB_PATH:-"<empty>"}"
  echo "🔍 [DEBUG] SCB resolved: ${EFFECTIVE_ASTRA_SCB_PATH_RESOLVED:-"<empty>"}"
fi

# ---------------------------
# Connectivity test via Astra REST (curl) - optional
# ---------------------------

CONNECTIVITY_ICON="⚪"
CONNECTIVITY_DETAIL="REST connectivity test not executed."

if $RUN_REST; then
  if [[ -n "$EFFECTIVE_ASTRA_DB_ENDPOINT" && -n "$EFFECTIVE_ASTRA_DB_TOKEN" ]]; then
    log "📡 Running Astra connectivity test via REST (curl)..."

    endpoint_trimmed="${EFFECTIVE_ASTRA_DB_ENDPOINT%/}"
    test_url="${endpoint_trimmed}/api/rest/v2/metadata"

    if $SCRIPT_DEBUG; then
      echo "🔍 [DEBUG] Astra test URL: ${test_url}"
      echo "🔍 [DEBUG] Token prefix: ${EFFECTIVE_ASTRA_DB_TOKEN:0:16}..."
    fi

    resp_file
= "$(mktemp /tmp/astra_resp.XXXXXX)"
    http_code=$(curl -sS -o "$resp_file" -w "%{http_code}" \
      -H "X-Cassandra-Token: ${EFFECTIVE_ASTRA_DB_TOKEN}" \
      "$test_url" || echo "000")

    if $SCRIPT_DEBUG; then
      echo "🔍 [DEBUG] Astra HTTP status: ${http_code}"
      echo "🔍 [DEBUG] Astra response body:"
      sed 's/^/   /' "$resp_file"
    fi

    case "$http_code" in
    200)
      CONNECTIVITY_ICON="✅"
      CONNECTIVITY_DETAIL="Astra REST metadata endpoint reachable with token."
      ;;
    401 | 403)
      CONNECTIVITY_ICON="🔴"
      CONNECTIVITY_DETAIL="Astra REST auth failed (HTTP ${http_code} - check token or roles)."
      mark_red
      ;;
    404)
      CONNECTIVITY_ICON="🔴"
      CONNECTIVITY_DETAIL="Astra REST returned 404 (check endpoint or region or DB id)."
      mark_red
      ;;
    5*)
      CONNECTIVITY_ICON="🟠"
      CONNECTIVITY_DETAIL="Astra REST returned ${http_code} (remote service issue - non blocking)."
      ;;
    000)
      CONNECTIVITY_ICON="🔴"
      CONNECTIVITY_DETAIL="Astra REST call failed locally (HTTP 000 - network, DNS, or TLS problem)."
      mark_red
      ;;
    *)
      CONNECTIVITY_ICON="🟠"
      CONNECTIVITY_DETAIL="Astra REST returned unexpected code ${http_code} (non blocking)."
      ;;
    esac

    rm -f "$resp_file"
  else
    CONNECTIVITY_ICON="🟠"
    CONNECTIVITY_DETAIL="Missing endpoint or token; Astra REST connectivity not tested."
    mark_orange
  fi

  status_line "$CONNECTIVITY_ICON" "REST connectivity" "$CONNECTIVITY_DETAIL"
  hr
fi

# ---------------------------
# cqlsh secure-connect-bundle connectivity test (Astra)
# ---------------------------

CQLSH_TIMEOUT_SECONDS="${CQLSH_TIMEOUT_SECONDS:-20}"
CQLSH_CONNECTIVITY_ICON="⚪"
CQLSH_CONNECTIVITY_DETAIL="cqlsh test skipped."

if $CQLSH_OK; then
  if [[ -n "${EFFECTIVE_ASTRA_SCB_PATH_RESOLVED:-}" && -f "$EFFECTIVE_ASTRA_SCB_PATH_RESOLVED" ]]; then
    # Prefer Transit-decrypted token; fall back to legacy Env/KV if still present
    ASTRA_TOKEN_FOR_CQL="${DECRYPTED_ASTRA_DB_TOKEN:-$EFFECTIVE_ASTRA_DB_TOKEN}"

    if [[ -z "$ASTRA_TOKEN_FOR_CQL" ]]; then
      CQLSH_CONNECTIVITY_ICON="🟠"
      CQLSH_CONNECTIVITY_DETAIL="No Astra token available for cqlsh (neither Transit nor Env/KV)."
      mark_orange
    else
      log "💾 Running Astra CQL connectivity test via cqlsh bundle..."

      if $SCRIPT_DEBUG; then
        echo "🔍 [DEBUG] Bundle path (resolved): $EFFECTIVE_ASTRA_SCB_PATH_RESOLVED"
        if [[ -n "$DECRYPTED_ASTRA_DB_TOKEN" ]]; then
          echo "🔍 [DEBUG] Using token source: Transit"
        else
          echo "🔍 [DEBUG] Using token source: Env/KV"
        fi
        echo "🔍 [DEBUG] Running: cqlsh --secure-connect-bundle \"$EFFECTIVE_ASTRA_SCB_PATH_RESOLVED\" -u token -p ***** -e \"DESCRIBE KEYSPACES;\""
      fi

      # Temporarily disable 'set -e' so a failing cqlsh does not kill the whole script
      set +e
      CQLSH_OUTPUT="$(
        CQLSH_NO_BUNDLED_PYTHON=1 \
        cqlsh \
          --secure-connect-bundle "$EFFECTIVE_ASTRA_SCB_PATH_RESOLVED" \
          -u token \
          -p "$ASTRA_TOKEN_FOR_CQL" \
          -e "DESCRIBE KEYSPACES;" 2>&1
      )"
      CQLSH_RC=$?
      set -e

      if [[ $CQLSH_RC -eq 0 ]]; then
        CQLSH_CONNECTIVITY_ICON="🟢"
        CQLSH_CONNECTIVITY_DETAIL="cqlsh connected successfully via secure connect bundle."
        if $SCRIPT_DEBUG; then
          echo "🔍 [DEBUG] cqlsh output:"
          printf '   %s\n' "$CQLSH_OUTPUT"
        fi
      else
        CQLSH_CONNECTIVITY_ICON="🟠"
        CQLSH_CONNECTIVITY_DETAIL="cqlsh bundle connection failed (exit ${CQLSH_RC}) - treated as non blocking advanced check."
        mark_orange
        if $SCRIPT_DEBUG; then
          echo "🔍 [DEBUG] cqlsh error output:"
          printf '   %s\n' "$CQLSH_OUTPUT"
        fi
      fi
    fi
  else
    if [[ -n "${EFFECTIVE_ASTRA_SCB_PATH_RESOLVED:-}" && ! -f "$EFFECTIVE_ASTRA_SCB_PATH_RESOLVED" ]]; then
      CQLSH_CONNECTIVITY_ICON="🔴"
      CQLSH_CONNECTIVITY_DETAIL="Secure connect bundle path set but file not found: $EFFECTIVE_ASTRA_SCB_PATH_RESOLVED"
      mark_red
      if $SCRIPT_DEBUG; then
        echo "🔍 [DEBUG] Missing bundle file at (resolved): $EFFECTIVE_ASTRA_SCB_PATH_RESOLVED"
      fi
    else
      CQLSH_CONNECTIVITY_ICON="🟠"
      CQLSH_CONNECTIVITY_DETAIL="No secure connect bundle configured; cqlsh test skipped."
      mark_orange
    fi
  fi
else
  CQLSH_CONNECTIVITY_ICON="⚪"
  CQLSH_CONNECTIVITY_DETAIL="cqlsh not installed."
fi

status_line "$CQLSH_CONNECTIVITY_ICON" "cqlsh connectivity" "$CQLSH_CONNECTIVITY_DETAIL"
hr

# ---------------------------
# Summary
# ---------------------------

log ""
log "📊 Summary (Ray-style):"

if $HAS_TOKEN; then
  log "• Astra DB token (ASTRA_DB_TOKEN) in .env is 🔴"
fi

if $HAS_ID || $HAS_REGION || $HAS_KEYSPACE || $HAS_ENDPOINT; then
  log "• Astra DB config (ID or region or keyspace or endpoint) in .env is 🟠 (move to Vault)."
elif ! $HAS_TOKEN; then
  log "• No Astra DB settings found in .env (from a secrets perspective) = 🟢"
fi

if $VAULT_HAS_ASTRA_FIELDS; then
  log "• Astra DB ASTRA_DB_* fields in Vault (${VAULT_KV_MOUNT}/${ASTRA_VAULT_KEY}) = 🟢"
elif $VAULT_KV_OK; then
  log "• Vault KV reachable, but Astra fields incomplete = 🟠"
else
  log "• Astra DB credentials not retrievable from Vault = 🔴"
fi

if $RUN_REST; then
  case "$CONNECTIVITY_ICON" in
  "✅") log "• Astra can be reached with the credentials from Vault = ✅" ;;
  "🔴") log "• Astra connectivity test failed = 🔴" ;;
  "🟠") log "• Astra connectivity test reported non blocking REST warnings = 🟠" ;;
  *) log "• Astra connectivity test not executed = ⚪" ;;
  esac
fi

log ""
if $ANY_RED; then
  log "🚨 Global verdict: 🔴 FIX BEFORE CONTINUING"
elif $ANY_ORANGE; then
  log "⚠️  Global verdict: 🟠 WORKS, BUT NOT HOW WE WANT TO TEACH IT"
else
  log "✅ Global verdict: 🟢 SAFE FOR WORKSHOPS"
fi
log ""

if $STRICT && $ANY_RED; then
  die "Strict mode enabled and at least one 🔴 issue detected."
fi

exit 0
