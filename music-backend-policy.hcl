# Astra metadata in kv/datastax
path "kv/data/datastax" {
  capabilities = ["read", "update"]
}

# Astra token ciphertext in kv/astra
path "kv/data/astra" {
  capabilities = ["read", "update"]
}

# Allow encrypting with Transit key astra-transit
path "transit/encrypt/astra-transit" {
  capabilities = ["update"]
}

# Optional: allow decrypt as well (for future verify / debug flows)
path "transit/decrypt/astra-transit" {
  capabilities = ["update"]
}
