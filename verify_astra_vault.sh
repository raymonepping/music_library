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
# Usage:
#   ./verify_astra_vault.sh
#   ./verify_astra_vault.sh --strict
#   ./verify_astra_vault.sh --require-cqlsh
#
# Optional env:
#   CQLSH_TARBALL=/path/to/cqlsh-VERSION-bin.tar.gz
#   CQLSH_ASTRA_URL=override_download_url

set -euo pipefail

VERSION="0.8.0"

ENV_FILE="${ENV_FILE:-.env}"
STRICT=false
REQUIRE_CQLSH=false

RUN_REST=false
SCRIPT_DEBUG=false

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
  $0 [--strict] [--require-cqlsh] [--rest] [--debug]

Options:
  --strict          Treat any 🔴 finding as exit 1 (hard fail)
  --require-cqlsh   Treat missing cqlsh as 🔴 (hard blocker)
  --rest            Include Astra REST connectivity test
  --debug           Enable verbose debug output (implies --rest)
  -h, --help        Show this help message

Optional:
  CQLSH_TARBALL=/full/path/to/cqlsh-VERSION-bin.tar.gz
  CQLSH_ASTRA_URL=custom_download_url

EOF
}

PYTHON_VERSION_STR=""
PYTHON_MAJOR=0
PYTHON_MINOR=0
PYTHON_COMPAT="unknown"

detect_python_version() {
  PYTHON_VERSION_STR=$(python3 --version 2>/dev/null || true)
  PYTHON_MAJOR=0
  PYTHON_MINOR=0
  PYTHON_COMPAT="missing"

  if [[ -n "$PYTHON_VERSION_STR" ]]; then
    if [[ "$PYTHON_VERSION_STR" =~ ([0-9]+)\.([0-9]+)\. ]]; then
      PYTHON_MAJOR="${BASH_REMATCH[1]}"
      PYTHON_MINOR="${BASH_REMATCH[2]}"
      if ((PYTHON_MAJOR == 3 && PYTHON_MINOR >= 8 && PYTHON_MINOR <= 11)); then
        PYTHON_COMPAT="ok"
      elif ((PYTHON_MAJOR == 3 && PYTHON_MINOR >= 12)); then
        PYTHON_COMPAT="too_new"
      else
        PYTHON_COMPAT="other"
      fi
    else
      PYTHON_COMPAT="other"
    fi
  fi
}

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
  echo "   → ${tarball}"
  echo

  if ! curl -fL "${CQLSH_ASTRA_URL}" -o "${tarball}"; then
    echo "❌ Failed to download cqlsh-astra tarball from ${CQLSH_ASTRA_URL}"
    echo "   Check network / URL and try again."
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
  status_line "🟠" "ASTRA_DB_* config" "Non-secret Astra config present in .env (teachable: move into Vault)."
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
      -n "$VAULT_ASTRA_DB_KEYSPACE" && -n "$VAULT_ASTRA_DB_TOKEN" &&
      -n "$VAULT_ASTRA_DB_ENDPOINT" ]]; then
      VAULT_HAS_ASTRA_FIELDS=true
      status_line "🟢" "Vault KV fields" "All ASTRA_DB_* fields present in ${VAULT_KV_MOUNT}/${ASTRA_VAULT_KEY}."
    else
      if $JQ_OK; then
        missing_fields=()
        [[ -z "$VAULT_ASTRA_DB_ID" ]] && missing_fields+=("ASTRA_DB_ID")
        [[ -z "$VAULT_ASTRA_DB_REGION" ]] && missing_fields+=("ASTRA_DB_REGION")
        [[ -z "$VAULT_ASTRA_DB_KEYSPACE" ]] && missing_fields+=("ASTRA_DB_KEYSPACE")
        [[ -z "$VAULT_ASTRA_DB_TOKEN" ]] && missing_fields+=("ASTRA_DB_TOKEN")
        [[ -z "$VAULT_ASTRA_DB_ENDPOINT" ]] && missing_fields+=("ASTRA_DB_ENDPOINT")
        status_line "🟠" "Vault KV fields" "Missing or empty: ${missing_fields[*]}."
        mark_orange
      fi
    fi
  else
    status_line "🔴" "Vault KV read" "Failed to read ${vault_url} (path/permissions/auth?)."
    VAULT_KV_OK=false
    mark_red
  fi
else
  log "⚠️  Skipping Vault KV read (Vault env not OK)."
fi
hr

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

if [[ -n "$EFFECTIVE_ASTRA_DB_ID" && -n "$EFFECTIVE_ASTRA_DB_REGION" &&
  -n "$EFFECTIVE_ASTRA_DB_KEYSPACE" && -n "$EFFECTIVE_ASTRA_DB_TOKEN" &&
  -n "$EFFECTIVE_ASTRA_DB_ENDPOINT" ]]; then
  status_line "🟢" "Effective config" "All effective Astra fields available (Vault preferred)."
else
  status_line "🟠" "Effective config" "Effective Astra config incomplete (missing ID/region/keyspace/token/endpoint)."
  mark_orange
fi
hr

# ---------------------------
# 6. Connectivity test via Astra REST (curl)
# ---------------------------

# ---------------------------
# 6. Connectivity test via Astra REST (curl) – optional
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

    resp_file="$(mktemp /tmp/astra_resp.XXXXXX)"
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
      CONNECTIVITY_DETAIL="Astra REST auth failed (HTTP ${http_code} – check token / roles)."
      mark_red
      ;;
    404)
      CONNECTIVITY_ICON="🔴"
      CONNECTIVITY_DETAIL="Astra REST returned 404 (check endpoint / region / DB id)."
      mark_red
      ;;
    5*)
      CONNECTIVITY_ICON="🟠"
      CONNECTIVITY_DETAIL="Astra REST returned ${http_code} (remote service issue – non-blocking)."
      ;;
    000)
      CONNECTIVITY_ICON="🔴"
      CONNECTIVITY_DETAIL="Astra REST call failed locally (HTTP 000 – network/DNS/TLS problem)."
      mark_red
      ;;
    *)
      CONNECTIVITY_ICON="🟠"
      CONNECTIVITY_DETAIL="Astra REST returned unexpected code ${http_code} (non-blocking)."
      ;;
    esac

    rm -f "$resp_file"
  else
    CONNECTIVITY_ICON="🟠"
    CONNECTIVITY_DETAIL="Missing endpoint or token; Astra REST connectivity not tested."
    mark_orange
  fi
fi

status_line "$CONNECTIVITY_ICON" "REST connectivity" "$CONNECTIVITY_DETAIL"
hr

# ---------------------------
# 7. cqlsh secure-connect-bundle connectivity test (Astra)
# ---------------------------

CQLSH_CONNECTIVITY_ICON="⚪"
CQLSH_CONNECTIVITY_DETAIL="cqlsh test skipped."

if $CQLSH_OK; then
  if [[ -n "${EFFECTIVE_ASTRA_SCB_PATH:-}" && -f "$EFFECTIVE_ASTRA_SCB_PATH" ]]; then
    log "💾 Running Astra CQL connectivity test via cqlsh bundle..."

    if $SCRIPT_DEBUG; then
      echo "🔍 [DEBUG] Bundle path: $EFFECTIVE_ASTRA_SCB_PATH"
      echo "🔍 [DEBUG] Running: cqlsh --secure-connect-bundle \"\$EFFECTIVE_ASTRA_SCB_PATH\" -u token -p ***** -e \"DESCRIBE KEYSPACES;\""
    fi

    CQLSH_OUTPUT="$(
      cqlsh \
        --secure-connect-bundle "$EFFECTIVE_ASTRA_SCB_PATH" \
        -u token \
        -p "$EFFECTIVE_ASTRA_DB_TOKEN" \
        -e "DESCRIBE KEYSPACES;" 2>&1
    )"
    CQLSH_RC=$?

    if [[ $CQLSH_RC -eq 0 ]]; then
      CQLSH_CONNECTIVITY_ICON="🟢"
      CQLSH_CONNECTIVITY_DETAIL="cqlsh connected successfully via secure connect bundle."
    else
      CQLSH_CONNECTIVITY_ICON="🔴"
      CQLSH_CONNECTIVITY_DETAIL="cqlsh bundle connection failed."
      mark_red
      if $SCRIPT_DEBUG; then
        echo "🔍 [DEBUG] cqlsh error:"
        sed 's/^/   /' <<<"$CQLSH_OUTPUT"
      fi
    fi
  else
    if [[ -n "${EFFECTIVE_ASTRA_SCB_PATH:-}" && ! -f "$EFFECTIVE_ASTRA_SCB_PATH" ]]; then
      CQLSH_CONNECTIVITY_ICON="🔴"
      CQLSH_CONNECTIVITY_DETAIL="Secure connect bundle path set but file not found."
      mark_red
      if [[ "${DEBUG:-false}" == "true" ]]; then
        echo "🔍 [DEBUG] Missing bundle file at: $EFFECTIVE_ASTRA_SCB_PATH"
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
  log "• Astra DB config (ID/region/keyspace/endpoint) in .env is 🟠 (move to Vault)."
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

case "$CONNECTIVITY_ICON" in
"✅") log "• Astra can be reached with the credentials from Vault = ✅" ;;
"🔴") log "• Astra connectivity test failed = 🔴" ;;
"🟠") log "• Astra connectivity test reported non-blocking REST warnings = 🟠" ;;
*) log "• Astra connectivity test not executed = ⚪" ;;
esac

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
