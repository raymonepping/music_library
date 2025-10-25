// backend/routes/index.js
const express = require("express");
const router = express.Router();

const ensureToken = require("../middleware/ensureToken");

// Controllers
const { stats } = require("../controllers/statsController");

const {
  listColumns,
  startBuild,
  getStatus,
  getTop,
} = require("../controllers/derivedArtistsController");

const {
  login,
  callback,
  logout,
  health,
  tokens,
} = require("../controllers/authController");

const {
  me,
  playlists,
  playlistTracks,
} = require("../controllers/spotifyController");

const { syncPost, syncRedirect } = require("../controllers/syncController");
const { cqlHealth, root } = require("../controllers/healthController");

const {
  meFromDb,
  playlistsFromDb,
} = require("../controllers/dataStaxController");

const { searchArtists } = require("../controllers/searchController");
const { searchArtistsPrefixSAI } = require("../controllers/searchController");

const {
  getArtist,
  getArtistAlbums,
  listArtists,
} = require("../controllers/artistsController");

const { getAlbum, listAlbums } = require("../controllers/albumsController");

const { similarArtists } = require("../controllers/vectorController");

/**
 * @openapi
 * tags:
 *   - name: Root
 *     description: Landing page
 *   - name: Health
 *     description: Health & diagnostics
 *   - name: Auth
 *     description: Spotify OAuth 2.0 flow
 *   - name: Spotify
 *     description: Spotify proxy endpoints (session auth required)
 *   - name: DB
 *     description: Read synced data from Astra (no auth required)
 *   - name: Sync
 *     description: Sync Spotify data into Astra (Cassandra)
 *   - name: Catalog
 *     description: Artists and albums from Astra (no auth required)
 *   - name: Search
 *     description: Lightweight search endpoints
 */

/**
 * @openapi
 * /:
 *   get:
 *     summary: Root HTML
 *     tags: [Root]
 *     responses:
 *       200:
 *         description: HTML landing page
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 */
router.get("/", root);

/**
 * @openapi
 * /health:
 *   get:
 *     summary: Simple health check
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: OK
 *       500:
 *         description: Server error
 */
router.get("/health", health);

/**
 * @openapi
 * /auth/login:
 *   get:
 *     summary: Start Spotify OAuth
 *     tags: [Auth]
 *     responses:
 *       302:
 *         description: Redirect to Spotify authorization
 */
router.get("/auth/login", login);

/**
 * @openapi
 * /auth/callback:
 *   get:
 *     summary: Spotify OAuth callback
 *     tags: [Auth]
 *     parameters:
 *       - in: query
 *         name: code
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: state
 *         required: false
 *         schema:
 *           type: string
 *     responses:
 *       302:
 *         description: Redirect back to root with a session
 *       500:
 *         description: Auth failed
 */
router.get("/auth/callback", callback);

/**
 * @openapi
 * /logout:
 *   get:
 *     summary: Destroy session
 *     tags: [Auth]
 *     responses:
 *       302:
 *         description: Redirect to root
 */
router.get("/logout", logout);

/**
 * @openapi
 * /api/me:
 *   get:
 *     summary: Get current Spotify user profile (live)
 *     tags: [Spotify]
 *     responses:
 *       200:
 *         description: Spotify 'me' payload
 *       401:
 *         description: Not authenticated
 */
router.get("/api/me", ensureToken, me);

/**
 * @openapi
 * /api/playlists:
 *   get:
 *     summary: List current user's playlists from Spotify (paginated at Spotify)
 *     tags: [Spotify]
 *     responses:
 *       200:
 *         description: Array of playlists
 *       401:
 *         description: Not authenticated
 */
router.get("/api/playlists", ensureToken, playlists);

/**
 * @openapi
 * /api/playlists/{id}/tracks:
 *   get:
 *     summary: List tracks for a playlist (from Spotify)
 *     tags: [Spotify]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Spotify playlist ID
 *     responses:
 *       200:
 *         description: Array of playlist track items
 *       401:
 *         description: Not authenticated
 */
router.get("/api/playlists/:id/tracks", ensureToken, playlistTracks);

/**
 * @openapi
 * /api/db/me:
 *   get:
 *     summary: Get user profile from Astra (synced data)
 *     tags: [DB]
 *     responses:
 *       200:
 *         description: User profile mapped to Spotify-like shape
 *       404:
 *         description: No user found (run a sync first)
 *       500:
 *         description: Server error
 */
router.get("/api/db/me", meFromDb);

/**
 * @openapi
 * /api/db/playlists:
 *   get:
 *     summary: List playlists from Astra (synced data)
 *     tags: [DB]
 *     responses:
 *       200:
 *         description: Array of playlists mapped to Spotify-like shape
 *       500:
 *         description: Server error
 */
router.get("/api/db/playlists", playlistsFromDb);

/**
 * @openapi
 * /api/sync/spotify:
 *   post:
 *     summary: Sync Spotify data into Astra (Cassandra)
 *     tags: [Sync]
 *     responses:
 *       200:
 *         description: Sync result
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Sync failed
 */
router.post("/api/sync/spotify", ensureToken, syncPost);

/**
 * @openapi
 * /sync/spotify:
 *   get:
 *     summary: Redirect-based sync (safe with SameSite=Lax session cookie)
 *     tags: [Sync]
 *     responses:
 *       302:
 *         description: Redirects back to frontend with query params (synced, pc, tc)
 *       401:
 *         description: Not authenticated
 */
router.get("/sync/spotify", ensureToken, syncRedirect);

/**
 * @openapi
 * /api/cql/health:
 *   get:
 *     summary: CQL connection health check
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: OK with keyspace info
 *       500:
 *         description: Error
 */
router.get("/api/cql/health", cqlHealth);

/**
 * @openapi
 * /artists/{id}:
 *   get:
 *     summary: Get artist by ID
 *     tags: [Catalog]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Spotify artist ID
 *     responses:
 *       200:
 *         description: Artist details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 artist_id:
 *                   type: string
 *                 name:
 *                   type: string
 *                 genres:
 *                   type: array
 *                   items: { type: string }
 *                 followers:
 *                   type: integer
 *                 popularity:
 *                   type: integer
 *                 images:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       url: { type: string }
 *                       height: { type: integer }
 *                       width: { type: integer }
 *                 updated_at:
 *                   type: string
 *                   format: date-time
 *       404:
 *         description: Artist not found
 *       500:
 *         description: Server error
 */
router.get("/artists/:id", getArtist);

router.get("/albums", listAlbums);

/**
 * @openapi
 * /artists/{id}/albums:
 *   get:
 *     summary: List albums for an artist
 *     tags: [Catalog]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Spotify artist ID
 *       - in: query
 *         name: limit
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 200
 *           default: 50
 *       - in: query
 *         name: page_state
 *         required: false
 *         schema:
 *           type: string
 *         description: Cassandra paging state token from previous response
 *     responses:
 *       200:
 *         description: Albums by artist with paging
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       album_id: { type: string }
 *                       name: { type: string }
 *                       release_date: { type: string }
 *                 limit:
 *                   type: integer
 *                 next_page_state:
 *                   type: string
 *                   nullable: true
 *                 has_more:
 *                   type: boolean
 *       500:
 *         description: Server error
 */
router.get("/artists/:id/albums", getArtistAlbums);

/**
 * @openapi
 * /albums/{id}:
 *   get:
 *     summary: Get album by ID
 *     tags: [Catalog]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Spotify album ID
 *     responses:
 *       200:
 *         description: Album details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 album_id: { type: string }
 *                 name: { type: string }
 *                 album_type: { type: string }
 *                 release_date: { type: string }
 *                 total_tracks: { type: integer }
 *                 images:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       url: { type: string }
 *                       height: { type: integer }
 *                       width: { type: integer }
 *                 artists:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       name: { type: string }
 *                 updated_at:
 *                   type: string
 *                   format: date-time
 *       404:
 *         description: Album not found
 *       500:
 *         description: Server error
 */
router.get("/albums/:id", getAlbum);

/**
 * @openapi
 * /search/artists:
 *   get:
 *     summary: Search artists by exact name or prefix
 *     tags: [Search]
 *     parameters:
 *       - in: query
 *         name: name
 *         required: false
 *         schema:
 *           type: string
 *         description: Exact, case-insensitive match (normalized to lowercase)
 *       - in: query
 *         name: prefix
 *         required: false
 *         schema:
 *           type: string
 *         description: Prefix, case-insensitive. Uses 2..3 char buckets for speed.
 *       - in: query
 *         name: limit
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 25
 *     responses:
 *       200:
 *         description: Matching artists
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   artist_id: { type: string }
 *                   name: { type: string }
 *       400:
 *         description: Missing query params
 *       500:
 *         description: Server error
 */
router.get(
  "/search/artists",
  require("../controllers/searchController").searchArtists,
);
router.get(
  "/search/artists/exact",
  require("../controllers/searchController").searchArtistsExact,
);
router.get(
  "/search/artists/prefix-sai",
  require("../controllers/searchController").searchArtistsPrefixSAI,
);

// list (browse all)
router.get("/artists", listArtists);

// ... later, under your other routes
/**
 * @openapi
 * /vectors/artists/{id}/similar:
 *   get:
 *     summary: Find similar artists using vector embeddings
 *     tags: [DB]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: artist_id to use as the base vector
 *       - in: query
 *         name: limit
 *         required: false
 *         schema: { type: integer, default: 5, minimum: 1, maximum: 25 }
 *     responses:
 *       200:
 *         description: Base artist and top similar items
 *       404:
 *         description: Artist not found or no embedding
 *       500:
 *         description: Server error
 */
router.get("/vectors/artists/:id/similar", similarArtists);

router.get("/auth/tokens", tokens);

router.get("/api/stats", stats);

// Columns your UI can offer
router.get("/iterate/columns", listColumns);

// Kick off a derived table build
router.post("/iterate/build", express.json(), startBuild);

// Poll job status
router.get("/iterate/status/:id", getStatus);

// Preview/top sample from derived table
router.get("/iterate/top", getTop);

module.exports = router;
