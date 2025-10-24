import fetch from "node-fetch";

export async function readKvV2({ addr, token, mount, path }) {
  const url = `${addr}/v1/${mount}/data/${encodeURIComponent(path)}`;
  const res = await fetch(url, { headers: { "X-Vault-Token": token } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Vault read failed ${res.status}: ${text}`);
  }
  const json = await res.json();
  return json?.data?.data ?? {};
}
