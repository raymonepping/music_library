// backend/controllers/healthController.js
const { getClient, KEYSPACE, ensureSchema } = require("../services/cassandra");

async function cqlHealth(req, res) {
  try {
    const client = getClient();
    await client.connect();
    await ensureSchema();
    const rs = await client.execute("SELECT key FROM system.local");
    const KS = KEYSPACE(); // <-- call the function
    res.json({ ok: true, keyspace: KS, rows: rs.rowLength });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}

function root(req, res) {
  const loggedIn = Boolean(req.session && req.session.accessToken);
  const redirectUri =
    process.env.SPOTIFY_REDIRECT_URI || "http://localhost:3002/auth/callback";
  const html = `
<!doctype html><html><head><meta charset="utf-8"/><title>Spotify Showcase</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;padding:24px;line-height:1.4}a{display:inline-block;margin:6px 0;}code{background:#f4f4f4;padding:2px 4px;border-radius:4px;}</style>
</head><body>
<h1>Spotify Showcase</h1>
<p>Status: ${loggedIn ? "✅ Authenticated" : "⚠️ Not authenticated"}</p>
<div>
  ${
    loggedIn
      ? `<a href="/api/me">/api/me</a><br/><a href="/api/playlists">/api/playlists</a><br/><a href="/logout">/logout</a><br/>`
      : `<a href="/auth/login">Login with Spotify</a><br/>`
  }
</div>
<hr/>
<p>Health: <a href="/health">/health</a></p>
<p>Redirect URI in use: <code>${redirectUri}</code></p>
</body></html>`;
  res.type("html").send(html);
}

module.exports = { cqlHealth, root };
