// backend/vaultClient.js
// Vault client for KV v2 and Transit

const { Buffer } = require("node:buffer");

// If you are on Node 18+ you have global fetch.
// If not, uncomment the next line and install node-fetch.
// const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

function buildHeaders(token, namespace) {
  if (!token) {
    throw new Error("Vault token is required");
  }

  const headers = {
    "X-Vault-Token": token,
    "Content-Type": "application/json",
  };

  if (namespace) {
    headers["X-Vault-Namespace"] = namespace;
  }

  return headers;
}

/**
 * Factory that returns a small Vault client.
 *
 * options:
 *   addr        : Vault address, for example "https://vault.example.com"
 *   token       : Vault token
 *   namespace   : optional Vault namespace
 *   kvMount     : KV v2 mount (default "kv")
 *   transitKey  : Transit key name (default "astra-transit")
 */
function createVaultClient({
  addr,
  token,
  namespace,
  kvMount = "kv",
  transitKey = "astra-transit",
}) {
  if (!addr) {
    throw new Error("Vault addr is required");
  }

  const baseUrl = addr.replace(/\/+$/, "");

  async function readKvV2(path) {
    const url = `${baseUrl}/v1/${kvMount}/data/${encodeURIComponent(path)}`;

    const res = await fetch(url, {
      method: "GET",
      headers: buildHeaders(token, namespace),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Vault KV read failed ${res.status}: ${text}`);
    }

    const json = await res.json();
    // KV v2 shape: { data: { data: { ... }, metadata: { ... } } }
    return json && json.data && json.data.data ? json.data.data : {};
  }

  async function transitEncrypt(plaintext) {
    if (typeof plaintext !== "string") {
      throw new Error("transitEncrypt expects plaintext as string");
    }

    const url = `${baseUrl}/v1/transit/encrypt/${encodeURIComponent(
      transitKey,
    )}`;

    const body = JSON.stringify({
      plaintext: Buffer.from(plaintext, "utf8").toString("base64"),
    });

    const res = await fetch(url, {
      method: "POST",
      headers: buildHeaders(token, namespace),
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Vault transit encrypt failed ${res.status}: ${text}`);
    }

    const json = await res.json();
    const ciphertext = json && json.data && json.data.ciphertext;

    if (!ciphertext) {
      throw new Error("Vault transit encrypt response missing data.ciphertext");
    }

    return ciphertext;
  }

  async function transitDecrypt(ciphertext) {
    if (!ciphertext || typeof ciphertext !== "string") {
      throw new Error("transitDecrypt expects ciphertext as non empty string");
    }

    const url = `${baseUrl}/v1/transit/decrypt/${encodeURIComponent(
      transitKey,
    )}`;

    const body = JSON.stringify({ ciphertext });

    const res = await fetch(url, {
      method: "POST",
      headers: buildHeaders(token, namespace),
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Vault transit decrypt failed ${res.status}: ${text}`);
    }

    const json = await res.json();
    const plaintextB64 = json && json.data && json.data.plaintext;

    if (!plaintextB64) {
      throw new Error("Vault transit decrypt response missing data.plaintext");
    }

    return Buffer.from(plaintextB64, "base64").toString("utf8");
  }

  /**
   * High level helper for your Astra case.
   *
   * KV path is configurable via VAULT_ASTRA_KV_PATH
   * Defaults to "astra"
   */
  async function getAstraTokens(kvPathOverride) {
    const kvPath = kvPathOverride || "astra";
    const kvData = await readKvV2(kvPath);

    const appCipher = kvData.ASTRA_DB_APPLICATION_TOKEN;
    const dbCipher = kvData.ASTRA_DB_TOKEN;

    if (!appCipher || !dbCipher) {
      throw new Error(
        `KV data at '${kvPath}' is missing ASTRA_DB_APPLICATION_TOKEN or ASTRA_DB_TOKEN`,
      );
    }

    const [appToken, dbToken] = await Promise.all([
      transitDecrypt(appCipher),
      transitDecrypt(dbCipher),
    ]);

    return {
      ASTRA_DB_APPLICATION_TOKEN: appToken,
      ASTRA_DB_TOKEN: dbToken,
    };
  }

  return {
    readKvV2,
    transitEncrypt,
    transitDecrypt,
    getAstraTokens,
  };
}

module.exports = {
  createVaultClient,
};
// ---- END OF FILE ----