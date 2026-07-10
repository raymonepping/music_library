#!/usr/bin/env bash
set -euo pipefail

# vault_write_approle_creds.sh
#
# Usage:
#   ./vault_write_approle_creds.sh <role_name> <output_file>
#
# Example:
#   ./vault_write_approle_creds.sh music-backend backend/approle.env
#
# Output file content example:
#   ROLE_ID=1234-...
#   SECRET_ID=abcd-...

ROLE_NAME="${1:-}"
OUTPUT_FILE="${2:-}"

if [[ -z "$ROLE_NAME" || -z "$OUTPUT_FILE" ]]; then
  echo "Usage: $0 <role_name> <output_file>"
  exit 1
fi

if [[ -z "${VAULT_ADDR:-}" ]]; then
  echo "❌ VAULT_ADDR must be set (example: http://127.0.0.1:18200)"
  exit 1
fi

echo "🔐 Writing AppRole credentials to file"
echo "   VAULT_ADDR   = $VAULT_ADDR"
echo "   ROLE_NAME    = $ROLE_NAME"
echo "   OUTPUT_FILE  = $OUTPUT_FILE"
echo

# --------------------------------------------------------------------
# 1. Fetch role_id
# --------------------------------------------------------------------
echo "📥 Reading role_id..."
ROLE_ID=$(vault read -field=role_id "auth/approle/role/${ROLE_NAME}/role-id")
echo "   role_id = $ROLE_ID"
echo

# --------------------------------------------------------------------
# 2. Generate secret_id
# --------------------------------------------------------------------
echo "🧪 Generating secret_id..."
SECRET_ID=$(vault write -f -field=secret_id "auth/approle/role/${ROLE_NAME}/secret-id")
echo "   secret_id = $SECRET_ID"
echo

# --------------------------------------------------------------------
# 3. Write both values to file
# --------------------------------------------------------------------
echo "📄 Writing credentials to $OUTPUT_FILE"

cat > "$OUTPUT_FILE" <<EOF
ROLE_ID=$ROLE_ID
SECRET_ID=$SECRET_ID
EOF

echo "   ✔ File created"
echo

# --------------------------------------------------------------------
# 4. Final summary
# --------------------------------------------------------------------
echo "📋 Summary:"
echo "   ROLE_ID written"
echo "   SECRET_ID written"
echo "   File: $OUTPUT_FILE"

echo
echo "Done."
