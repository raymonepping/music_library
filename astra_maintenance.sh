#!/usr/bin/env bash
# astra_maintenance.sh
#
# Mother script that runs:
#   1) astra_rotation.sh
#   2) astra_prune.sh --keep N
#   3) verify_astra_vault.sh --transit   (optional, default: on)
#
# Defaults:
#   ENV_FILE=.env
#   KEEP_COUNT=2
#
# Usage:
#   ./astra_maintenance.sh
#   ./astra_maintenance.sh --dry-run
#   ./astra_maintenance.sh --keep 3
#   ./astra_maintenance.sh --debug
#   ./astra_maintenance.sh --quiet
#   ./astra_maintenance.sh --skip-verify
#
# This script does not write tokens itself. It delegates safely
# to the existing scripts, and when --quiet is used it also passes
# --quiet to rotation and prune.

set -euo pipefail

VERSION="1.2.0"

ENV_FILE="${ENV_FILE:-.env}"
KEEP_COUNT=2
DRY_RUN=false
SCRIPT_DEBUG="${SCRIPT_DEBUG:-false}"
QUIET=false
SKIP_VERIFY=false

ROTATION_SCRIPT="./astra_rotation.sh"
PRUNE_SCRIPT="./astra_prune.sh"
VERIFY_SCRIPT="./verify_astra_vault.sh"

log() {
  $QUIET && return
  printf '%s\n' "$@" >&2
}

die() {
  printf '❌ %s\n' "$*" >&2
  exit 1
}

usage() {
  cat >&2 <<EOF
astra_maintenance.sh v${VERSION}

Runs Astra rotation + pruning (+ optional verification) in a clean workflow.

Usage:
  \$0 [--keep N] [--dry-run] [--debug] [--env-file PATH] [--quiet] [--skip-verify]

Options:
  --keep N           Number of newest tokens to keep (default: 2)
  --dry-run          Rotate in dry-run mode + prune in dry-run
  --debug            Enable debug mode for child scripts (SCRIPT_DEBUG=true)
  --env-file PATH    Path to env file (default: .env)
  --quiet            Reduce output; also passes --quiet to rotation and prune
  --skip-verify      Skip verify_astra_vault.sh step
  --verify-script P  Override verify script path (default: ./verify_astra_vault.sh)
  -h, --help         Show help

EOF
}

# ---------------------------
# Arg parsing
# ---------------------------

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep)
      KEEP_COUNT="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --debug)
      SCRIPT_DEBUG=true
      shift
      ;;
    --env-file)
      ENV_FILE="${2:-}"
      shift 2
      ;;
    --quiet)
      QUIET=true
      shift
      ;;
    --skip-verify)
      SKIP_VERIFY=true
      shift
      ;;
    --verify-script)
      VERIFY_SCRIPT="${2:-}"
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

# Basic sanity for KEEP_COUNT
if ! [[ "$KEEP_COUNT" =~ ^[0-9]+$ ]]; then
  die "--keep must be an integer (got: $KEEP_COUNT)"
fi

# ---------------------------
# Load .env (optional)
# ---------------------------

if [[ -f "$ENV_FILE" ]]; then
  log "📦 Loading environment from ${ENV_FILE}"
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
else
  log "⚠️ No env file found at ${ENV_FILE}, continuing..."
fi

# Make sure children see the same env file
export ENV_FILE

# ---------------------------
# Check scripts exist
# ---------------------------

[[ -x "$ROTATION_SCRIPT" ]] || die "Rotation script not executable: $ROTATION_SCRIPT"
[[ -x "$PRUNE_SCRIPT"    ]] || die "Prune script not executable: $PRUNE_SCRIPT"

if ! $SKIP_VERIFY; then
  [[ -x "$VERIFY_SCRIPT" ]] || die "Verify script not executable: $VERIFY_SCRIPT"
fi

# ---------------------------
# Debug propagation
# ---------------------------

if [[ "$SCRIPT_DEBUG" == "true" ]]; then
  export SCRIPT_DEBUG=true
  log "🔍 Debug mode enabled for child scripts"
fi

hr() { echo "----------------------------------------" >&2; }

# ---------------------------
# Step 1: Rotate
# ---------------------------

log "🚀 Step 1: Rotating Astra token..."

ROT_ARGS=()
$DRY_RUN && ROT_ARGS+=(--dry-run)
[[ "$SCRIPT_DEBUG" == "true" ]] && ROT_ARGS+=(--debug)
$QUIET && ROT_ARGS+=(--quiet)

"$ROTATION_SCRIPT" "${ROT_ARGS[@]}"
hr

# ---------------------------
# Step 2: Prune
# ---------------------------

log "🗑️  Step 2: Pruning old Astra tokens (keeping $KEEP_COUNT)..."

PRUNE_ARGS=(--keep "$KEEP_COUNT")
$DRY_RUN && PRUNE_ARGS+=(--dry-run)
[[ "$SCRIPT_DEBUG" == "true" ]] && PRUNE_ARGS+=(--debug)
$QUIET && PRUNE_ARGS+=(--quiet)

"$PRUNE_SCRIPT" "${PRUNE_ARGS[@]}"
hr

# ---------------------------
# Step 3: Verify (optional)
# ---------------------------

if $SKIP_VERIFY; then
  log "⏭️  Step 3: Skipping verification (user requested --skip-verify)."
else
  log "🔍 Step 3: Verifying Astra ↔ Vault alignment via ${VERIFY_SCRIPT}..."
  # Verification is read-only, so we run it even in dry-run mode
  if [[ "$SCRIPT_DEBUG" == "true" ]]; then
    "$VERIFY_SCRIPT" --transit --debug || die "Verification script failed."
  else
    "$VERIFY_SCRIPT" --transit || die "Verification script failed."
  fi
  hr
fi

# ---------------------------
# Summary
# ---------------------------

log "📋 Maintenance summary:"
log "  - Rotation:       $( if $DRY_RUN; then echo "dry-run"; else echo "executed"; fi )"
log "  - Pruning:        keep $KEEP_COUNT tokens"
log "  - Verification:   $( if $SKIP_VERIFY; then echo "skipped"; else echo "executed"; fi )"
log "  - ENV file:       $ENV_FILE"
log "  - Debug:          $SCRIPT_DEBUG"
log ""

log "✅ Astra maintenance complete."