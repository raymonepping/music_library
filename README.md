# 🎵 Music Library — Data Engine with Spotify, Vault & Astra DB

A full-stack data engine that syncs, analyzes, and serves your Spotify world — powered by **Node.js**, **Express**, **Vue/Nuxt 3**, **Vault**, and **DataStax Astra (Cassandra)**.

---

## 🚀 Overview

Most people build dashboards.  
This project builds a **data engine** — a pipeline that connects to Spotify, stores and extends your music data in Astra DB, and exposes it securely through a modular API.

---

### 🧩 Architecture
- **Frontend:** Nuxt 3 + Tailwind (modern SPA)
- **Backend:** Express.js + Swagger UI + Vault integration
- **Database:** DataStax Astra DB (Cassandra)
- **Secrets:** HashiCorp Vault (KV v2 + Transit)
- **Sync Source:** Spotify Web API
- **Deployment:** Docker Compose or Terraform

---

## 🗂 Folder Structure

See [`FOLDER_TREE.md`](./FOLDER_TREE.md) for the full breakdown.  
Key parts:

```
backend/
├─ controllers/ → REST endpoints (artists, albums, search, sync)
├─ services/ → integrations (Cassandra, Spotify, Vault)
├─ configurations/ → logger, swagger, env
├─ routes/ → Express + Swagger routing
└─ app.js / server.js
frontend/
├─ pages/ → Nuxt views (artists, albums, stats, search)
├─ components/ → UI building blocks
├─ composables/ → useApi.ts (Axios helpers)
└─ nuxt.config.ts
```

---

## ⚙️ Setup

### 1️⃣ Backend

```bash
cd backend
cp .env.example .env
docker compose up -d
```

Environment variables include:

```bash
PORT=3002
ASTRA_SCB_PATH=secure-connect-yourdb.zip
APPLICATION_TOKEN=AstraCS:...
ASTRA_DB_KEYSPACE=planetary
VAULT_ADDR=http://localhost:8200
VAULT_TOKEN=...
SPOTIFY_REDIRECT_URI=http://localhost:3002/auth/callback
```

Then open:

```bash
http://localhost:3002/api-docs  → Swagger UI
```

2️⃣ Frontend
```bash
cd frontend
npm install
npm run dev
```
Runs at:
- http://localhost:8075

---

### 🔐 Security
Vault KV v2: stores Spotify and Astra credentials
Vault Transit: signs JWTs for internal token exchange
Session Auth: Spotify OAuth 2.0 (refresh token saved securely)

### 💾 Database Schema
Tables are automatically created in Astra via:

backend/services/cassandra.js → ensureSchema()

users, playlists, tracks, playlist_tracks

Derived tables via /iterate/build for popularity/followers/name indexes

### 📊 Example API Endpoints
Endpoint	Description
/auth/login	Start Spotify OAuth flow
/api/sync/spotify	Import playlists and tracks
/api/db/me	Retrieve synced user
/artists/:id	Artist details
/vectors/artists/:id/similar	Find similar artists (vector embeddings)
/iterate/build	Build derived artist tables
/api/stats	Global statistics

Swagger UI documents them all.

---

## 🧩 Terraform Integration
Terraform configuration automates Astra DB creation and credentials injection via Vault.
See repository: IBM-HashiCorp-DataStax.

---

## 🧾 License

[GPLv3](LICENSE) © Raymon Epping
