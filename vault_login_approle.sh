#!/usr/bin/env bash
set -euo pipefail

# vault_login_approle.sh
#
# Usage:
#   ./vault_login_approle.sh <role_name>
#
# Output:
#   Exports VAULT_TOKEN into your environment (or prints instructions)
#   Prints short diagnostic output
#
# Requirements:
#   VAULT_ADDR must be set
#   You must be logged in with a token that can create SecretIDs
#
# Example:
#   VAULT_ADDR=http://127.0.0.1:18200 ./vault_login_approle.sh music-backend

ROLE_NAME="${1:-}"
if [[ -z "$ROLE_NAME" ]]; then
  echo "Usage: $0 <role_name>"
  exit 1
fi

if [[ -z "${VAULT_ADDR:-}" ]]; then
  echo "❌ VAULT_ADDR must be set (example: http://127.0.0.1:18200)"
  exit 1
fi

echo "🔐 Vault AppRole login"
echo "   VAULT_ADDR = $VAULT_ADDR"
echo "   ROLE_NAME  = $ROLE_NAME"
echo

# --------------------------------------------------------------------
# 1. Fetch role_id
# --------------------------------------------------------------------
echo "📥 Fetching role_id..."
ROLE_ID=$(vault read -field=role_id "auth/approle/role/${ROLE_NAME}/role-id")
echo "   role_id = $ROLE_ID"
echo

# --------------------------------------------------------------------
# 2. Generate new secret_id
# --------------------------------------------------------------------
echo "🧪 Generating new secret_id..."
SECRET_ID=$(vault write -f -field=secret_id "auth/approle/role/${ROLE_NAME}/secret-id")
echo "   secret_id = $SECRET_ID"
echo

# --------------------------------------------------------------------
# 3. Login to Vault via AppRole
# --------------------------------------------------------------------
echo "🔑 Logging in via AppRole..."
LOGIN_JSON=$(vault write -format=json auth/approle/login role_id="$ROLE_ID" secret_id="$SECRET_ID")

NEW_TOKEN=$(echo "$LOGIN_JSON" | jq -r '.auth.client_token')
TTL=$(echo "$LOGIN_JSON" | jq -r '.auth.lease_duration')

if [[ -z "$NEW_TOKEN" || "$NEW_TOKEN" == "null" ]]; then
  echo "❌ Failed to extract Vault token from login JSON."
  echo "$LOGIN_JSON"
  exit 1
fi

echo "   ✔ New token acquired (TTL ${TTL}s)"
echo

# --------------------------------------------------------------------
# 4. Export or print export command
# --------------------------------------------------------------------
export VAULT_TOKEN="$NEW_TOKEN"
echo "🌱 VAULT_TOKEN exported into this shell."

echo
echo "📋 Summary:"
echo "   role_id      = $ROLE_ID"
echo "   secret_id    = (hidden)"
echo "   VAULT_TOKEN  = (exported)"
echo "   TTL          = ${TTL}s"
echo
echo "You are now authenticated via AppRole."
