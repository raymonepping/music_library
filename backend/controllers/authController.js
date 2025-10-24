// backend/controllers/authController.js
const crypto = require('node:crypto')
const config = require('../configurations')
const logger = require('../configurations/logger')
const { makeSpotify, SCOPES } = require('../services/spotify')

// Optional: ensure we have the scopes we need
// Add 'user-follow-read' so we can pull followed artists
const REQUIRED_SCOPES = Array.from(new Set([
  ...SCOPES,
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-follow-read',
]))

function login(req, res) {
  // Persist a per-request state for CSRF protection
  const state = crypto.randomBytes(8).toString('hex')
  req.session.oauthState = state

  const api = makeSpotify({})
  // 3rd arg `showDialog=true` forces re-consent so Spotify will issue a refresh_token if it didn’t before
  const authorizeURL = api.createAuthorizeURL(REQUIRED_SCOPES, state, true)
  res.redirect(authorizeURL)
}

async function callback(req, res) {
  const { code, state } = req.query

  if (!code) {
    logger.error('[auth] missing code')
    return res.status(400).send('Missing code')
  }
  if (!state || state !== req.session.oauthState) {
    logger.error('[auth] state mismatch')
    return res.status(400).send('State mismatch')
  }

  const api = makeSpotify({})
  try {
    const { body } = await api.authorizationCodeGrant(code)

    // Save tokens in session
    req.session.accessToken = body.access_token
    req.session.refreshToken = body.refresh_token || req.session.refreshToken || null
    req.session.expiresAt = Date.now() + body.expires_in * 1000

    // Optional: quick console preview of refresh token so you can copy it to .env
    if (body.refresh_token) {
      // DO NOT log full access tokens
      console.log('[auth] refresh_token:', body.refresh_token)
    }

    // Clean up used state
    delete req.session.oauthState

    res.redirect('/')
  } catch (e) {
    logger.error('[auth] callback failed:', e?.body || e)
    res.status(500).send('Auth failed')
  }
}

function logout(req, res) {
  req.session.destroy(() => res.redirect('/'))
}

function health(req, res) {
  res.json({
    ok: true,
    spotifyConfigured: true,
    redirectUri: config.SPOTIFY_REDIRECT_URI,
  })
}

// Debug endpoint to retrieve refresh token from the current session
function tokens(req, res) {
  const at = req.session?.accessToken || null
  const rt = req.session?.refreshToken || null
  const exp = req.session?.expiresAt || null

  const access_preview = at
    ? at.slice(0, 12) + '…' + at.slice(-4)
    : null

  res.json({
    has_session: Boolean(at || rt),
    access_token_preview: access_preview,
    refresh_token: rt || null,
    expires_at: exp,
  })
}

module.exports = { login, callback, logout, health, tokens }
