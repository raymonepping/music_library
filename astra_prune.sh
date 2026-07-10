#!/usr/bin/env bash
# astra_prune.sh
#
# Prunes Astra tokens for a specific role (and optional description prefix),
# keeping only the N most recent ones.
#
# Typical use for your workshop:
#   - Role: workshop_admin
#
# It uses:
#   - Astra CLI: astra token list / astra token delete
#   - jq for filtering and sorting by generatedOn
#
# Safety:
#   - Supports --dry-run (no deletions, just a report)
#   - Only touches tokens matching:
#       - role filter
#       - AND optional description prefix (if the JSON ever includes it)
#
# .env integration:
#   ENV_FILE                        (default: .env)
#   ASTRA_ROTATION_ROLE             → default role if --role not set
#   ASTRA_TOKEN_DESCRIPTION_PREFIX  → default description prefix if --description-prefix not set
#
# New in v1.0.5:
#   - --quiet reduces non essential chatter

set -euo pipefail

VERSION="1.0.5"

KEEP_COUNT=3
DRY_RUN=false
SCRIPT_DEBUG="${SCRIPT_DEBUG:-false}"
QUIET=false

ENV_FILE="${ENV_FILE:-.env}"

ASTRA_PRUNE_ROLE="${ASTRA_PRUNE_ROLE:-}"
ASTRA_DESCRIPTION_PREFIX="${ASTRA_DESCRIPTION_PREFIX:-}"

OUTPUT_JSON=""   # optional: e.g. output/astra_prune_report.json

log() {
  printf '%s\n' "$@" >&2
}

vlog() {
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
  printf '%s %-28s %s\n' "$1" "$2" "$3" >&2
}

usage() {
  cat >&2 <<EOF
astra_prune.sh v${VERSION}

Prune Astra tokens for a given role (and optional description prefix),
keeping only the N most recent tokens.

Usage:
  \$0 [--keep N] [--role NAME] [--description-prefix STR] [--dry-run] [--output-json PATH] [--quiet]

Options:
  --keep N               Number of newest tokens to keep (default: 3)
  --role NAME            Astra role name to filter on.
                         Default resolution:
                           1) --role flag
                           2) ASTRA_PRUNE_ROLE
                           3) ASTRA_ROTATION_ROLE (from .env)
                           4) "workshop_admin"
  --description-prefix S Only prune tokens whose description starts with this prefix.
                         Only effective if the JSON includes a "description" field.
  --dry-run              Do not delete anything. Show what would be deleted.
  --output-json PATH     Write a JSON summary of kept/deleted tokens to PATH.
  --quiet                Reduce non essential output.
  -h, --help             Show this help text.

Environment:
  ENV_FILE                  Path to env file (default: .env)
  ASTRA_PRUNE_ROLE          Role to target (fallback for --role)
  ASTRA_ROTATION_ROLE       Role used by rotation, also used as default here
  ASTRA_DESCRIPTION_PREFIX  Description prefix (fallback for --description-prefix)
  ASTRA_TOKEN_DESCRIPTION_PREFIX
                            Preferred default for description prefix
  SCRIPT_DEBUG=true         Extra debug output

EOF
}

# ---------------------------
# Arg parsing
# ---------------------------

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep)
      KEEP_COUNT="${2:-}"
      if [[ -z "$KEEP_COUNT" ]]; then
        die "--keep requires a value"
      fi
      if ! [[ "$KEEP_COUNT" =~ ^[0-9]+$ ]]; then
        die "--keep must be an integer"
      fi
      shift 2
      ;;
    --role)
      ASTRA_PRUNE_ROLE="${2:-}"
      if [[ -z "$ASTRA_PRUNE_ROLE" ]]; then
        die "--role requires a value"
      fi
      shift 2
      ;;
    --description-prefix)
      ASTRA_DESCRIPTION_PREFIX="${2-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --output-json)
      OUTPUT_JSON="${2:-}"
      if [[ -z "$OUTPUT_JSON" ]]; then
        die "--output-json requires a path"
      fi
      shift 2
      ;;
    --quiet)
      QUIET=true
      shift
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

if [[ "$KEEP_COUNT" -lt 0 ]]; then
  die "--keep must be >= 0"
fi

# ---------------------------
# Load .env and resolve defaults
# ---------------------------

if [[ -f "$ENV_FILE" ]]; then
  vlog "📦 Loading environment from ${ENV_FILE}"
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

ASTRA_PRUNE_ROLE="${ASTRA_PRUNE_ROLE:-${ASTRA_ROTATION_ROLE:-workshop_admin}}"
ASTRA_DESCRIPTION_PREFIX="${ASTRA_DESCRIPTION_PREFIX:-${ASTRA_TOKEN_DESCRIPTION_PREFIX:-}}"

# ---------------------------
# Tool checks
# ---------------------------

if ! have_cmd astra; then
  status_line "🔴" "astra" "Astra CLI not found."
  die "Install Astra CLI first (brew install datastax/astra-cli/astra) and run 'astra setup'."
fi

if ! have_cmd jq; then
  status_line "🔴" "jq" "jq not found."
  die "Install jq first."
fi

if ! $QUIET; then
  log "🔧 Checking required tools..."
  status_line "🟢" "astra" "Found: $(command -v astra)"
  status_line "🟢" "jq" "Found: $(command -v jq)"
  hr
fi

# ---------------------------
# Fetch tokens
# ---------------------------

vlog "📥 Fetching Astra tokens via CLI..."
RAW_JSON="$(astra token list --output json)"

if [[ -z "$RAW_JSON" ]]; then
  die "astra token list returned empty output. Check Astra CLI setup."
fi

if [[ "$SCRIPT_DEBUG" == "true" && "$QUIET" == "false" ]]; then
  log "🔍 [DEBUG] Raw token list JSON:"
  echo "$RAW_JSON" | sed 's/^/   /' >&2
fi

HAS_DESCRIPTION_FIELD="$(
  echo "$RAW_JSON" \
    | jq '[.data[] | has("description")] | any' 2>/dev/null || echo "false"
)"

# ---------------------------
# Filter tokens
# ---------------------------

vlog "🔍 Filtering tokens..."
vlog "   Role filter:            ${ASTRA_PRUNE_ROLE}"
if [[ -n "$ASTRA_DESCRIPTION_PREFIX" ]]; then
  if [[ "$HAS_DESCRIPTION_FIELD" == "true" ]]; then
    vlog "   Description prefix:     ${ASTRA_DESCRIPTION_PREFIX} (filter enabled)"
  else
    vlog "   Description prefix:     ${ASTRA_DESCRIPTION_PREFIX} (JSON has no description field, filter skipped)"
  fi
else
  vlog "   Description prefix:     <none>"
fi
vlog "   Keep newest tokens:     ${KEEP_COUNT}"
hr

if [[ -n "$ASTRA_DESCRIPTION_PREFIX" && "$HAS_DESCRIPTION_FIELD" == "true" ]]; then
  FILTERED_JSON="$(
    echo "$RAW_JSON" \
      | jq --arg role "$ASTRA_PRUNE_ROLE" \
           --arg prefix "$ASTRA_DESCRIPTION_PREFIX" \
           '
           .data
           | map(
               . as $t
               | ($t.roleNames // []) as $roles
               | select( $roles | index($role) )
               | select( ($t.description // "") | startswith($prefix) )
             )
           '
  )"
else
  FILTERED_JSON="$(
    echo "$RAW_JSON" \
      | jq --arg role "$ASTRA_PRUNE_ROLE" \
           '
           .data
           | map(
               . as $t
               | ($t.roleNames // []) as $roles
               | select( $roles | index($role) )
             )
           '
  )"
fi

TOTAL_MATCHED="$(echo "$FILTERED_JSON" | jq 'length')"

if [[ "$TOTAL_MATCHED" -eq 0 ]]; then
  status_line "⚪" "Matched tokens" "No tokens match filters."
  log ""
  log "✅ Nothing to prune."
  exit 0
fi

status_line "🟢" "Matched tokens" "$TOTAL_MATCHED token(s) match filters."
hr

# ---------------------------
# Sort and split keep/delete
# ---------------------------

SORTED_JSON="$(
  echo "$FILTERED_JSON" \
    | jq 'sort_by(.generatedOn) | reverse'
)"

KEEP_JSON="$(
  echo "$SORTED_JSON" \
    | jq --argjson keep "$KEEP_COUNT" '
        if $keep <= 0 then
          []
        else
          .[0:$keep]
        end
      '
)"

DELETE_JSON="$(
  echo "$SORTED_JSON" \
    | jq --argjson keep "$KEEP_COUNT" '
        if $keep <= 0 then
          .
        else
          .[$keep:]
        end
      '
)"

KEEP_COUNT_ACTUAL="$(echo "$KEEP_JSON"    | jq 'length')"
DELETE_COUNT_ACTUAL="$(echo "$DELETE_JSON" | jq 'length')"

status_line "🟢" "Will keep"   "${KEEP_COUNT_ACTUAL} token(s) (newest)"
status_line "🟠" "Will delete" "${DELETE_COUNT_ACTUAL} token(s) (oldest)"
hr

if [[ "$SCRIPT_DEBUG" == "true" && "$QUIET" == "false" ]]; then
  log "🔍 [DEBUG] Tokens to keep:"
  echo "$KEEP_JSON" \
    | jq -r '.[] | "   keep   \(.clientId // "<no-id>")  \(.generatedOn // "<no-ts>")  roles=" + ((.roleNames // []) | join(","))' >&2 || true
  hr
  log "🔍 [DEBUG] Tokens to delete:"
  echo "$DELETE_JSON" \
    | jq -r '.[] | "   delete \(.clientId // "<no-id>")  \(.generatedOn // "<no-ts>")  roles=" + ((.roleNames // []) | join(","))' >&2 || true
  hr
fi

# ---------------------------
# Delete tokens (unless dry-run)
# ---------------------------

if [[ "$DELETE_COUNT_ACTUAL" -eq 0 ]]; then
  log "✅ Nothing to delete. Already at or under keep limit."
else
  if $DRY_RUN; then
    status_line "🟡" "Dry run" "No deletions will be performed."
    if ! $QUIET; then
      log "📝 Tokens that WOULD be deleted:"
      echo "$DELETE_JSON" \
        | jq -r '.[] | "   \(.clientId // "<no-id>")  \(.generatedOn // "<no-ts>")"' >&2 || true
    fi
  else
    if ! $QUIET; then
      log "🗑️  Deleting ${DELETE_COUNT_ACTUAL} token(s)..."
    fi
    while IFS= read -r cid; do
      if [[ -z "$cid" || "$cid" == "null" ]]; then
        continue
      fi

      if ! $QUIET; then
        log "   → Deleting token: ${cid}"
      fi
      if ! astra token delete "$cid" --if-exists --no-input --quiet >/dev/null 2>&1; then
        log "   ⚠️ Failed to delete token: ${cid} (continuing with others)."
      fi
    done < <(echo "$DELETE_JSON" | jq -r '.[].clientId // empty')

    status_line "🟢" "Deletion" "Requested deletion for ${DELETE_COUNT_ACTUAL} token(s)."
  fi
fi
hr

# ---------------------------
# Optional JSON output summary
# ---------------------------

if [[ -n "$OUTPUT_JSON" ]]; then
  mkdir -p "$(dirname "$OUTPUT_JSON")"

  SUMMARY_JSON="$(
    jq -n \
      --arg version "$VERSION" \
      --arg role "$ASTRA_PRUNE_ROLE" \
      --arg prefix "$ASTRA_DESCRIPTION_PREFIX" \
      --arg dry_run "$(if $DRY_RUN; then echo "true"; else echo "false"; fi)" \
      --argjson keep "$KEEP_COUNT" \
      --argjson matched "$TOTAL_MATCHED" \
      --argjson keep_tokens "$KEEP_JSON" \
      --argjson delete_tokens "$DELETE_JSON" \
      '
      {
        version: $version,
        role: $role,
        description_prefix: $prefix,
        dry_run: ($dry_run == "true"),
        keep_count_requested: $keep,
        matched_count: $matched,
        keep_tokens: $keep_tokens,
        delete_tokens: $delete_tokens
      }
      '
  )"

  printf '%s\n' "$SUMMARY_JSON" >"$OUTPUT_JSON"
  status_line "🟢" "Summary JSON" "Written to $OUTPUT_JSON"
fi

# ---------------------------
# Summary
# ---------------------------

log "📋 Prune summary:"
log "  - Role filter:        ${ASTRA_PRUNE_ROLE}"
log "  - Description prefix: ${ASTRA_DESCRIPTION_PREFIX:-<none>}"
log "  - Matched tokens:     ${TOTAL_MATCHED}"
log "  - Kept tokens:        ${KEEP_COUNT_ACTUAL}"
log "  - Deleted tokens:     ${DELETE_COUNT_ACTUAL}"
log "  - Dry run:            ${DRY_RUN}"
log ""

log "✅ Pruning flow complete."