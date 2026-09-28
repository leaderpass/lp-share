-- LP Link Hub — client-app DB (owns a projection of LPOS hub data).
-- LPOS is the source of truth and pushes rows here via POST /api/ingest on save.
-- This app never writes hub structure itself; it only reads (plus optional view_events).

PRAGMA journal_mode = WAL;

-- Finished videos, mirrored from LPOS assets. Only fields this app needs to play them.
CREATE TABLE IF NOT EXISTS assets (
  id             TEXT PRIMARY KEY,          -- LPOS assetId
  lpos_name      TEXT NOT NULL,             -- internal name (reference only; clients see hub_items.client_title)
  cf_stream_uid  TEXT NOT NULL,             -- Cloudflare Stream UID (what actually plays)
  duration_s     INTEGER NOT NULL DEFAULT 0,
  thumbnail_url  TEXT,                      -- Cloudflare frame thumbnail (per-video); null falls back to a gradient
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Standalone containers. NOT derived from a client.
CREATE TABLE IF NOT EXISTS hubs (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  owner_label  TEXT NOT NULL,               -- cosmetic: a client, a person, or "LeaderPass"
  owner_type   TEXT NOT NULL CHECK (owner_type IN ('client','person','leaderpass')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Who can log in. Independent of owner and of contents.
CREATE TABLE IF NOT EXISTS hub_access_emails (
  hub_id  TEXT NOT NULL REFERENCES hubs(id) ON DELETE CASCADE,
  email   TEXT NOT NULL,                     -- store lowercased
  PRIMARY KEY (hub_id, email)
);
CREATE INDEX IF NOT EXISTS idx_access_email ON hub_access_emails(email);

-- Membership: an asset placed in a hub. client_title + share_token live HERE
-- (the same asset in two hubs can have a different title and a different link).
CREATE TABLE IF NOT EXISTS hub_items (
  hub_id        TEXT NOT NULL REFERENCES hubs(id) ON DELETE CASCADE,
  asset_id      TEXT NOT NULL REFERENCES assets(id),
  client_title  TEXT NOT NULL,
  share_token   TEXT NOT NULL UNIQUE,        -- public link: /v/{share_token}
  sort_order    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hub_id, asset_id)
);
CREATE INDEX IF NOT EXISTS idx_items_token ON hub_items(share_token);

-- Optional, future: per-link view analytics (no schema change needed to turn on).
CREATE TABLE IF NOT EXISTS view_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  share_token  TEXT NOT NULL,
  viewed_at    TEXT NOT NULL DEFAULT (datetime('now')),
  referrer     TEXT
);

-- ═══════════════════════════════════════════════════════════════════════════
-- LP Share (see ../docs/share-app-spec.md §7). The Link Hub tables above stay
-- until cutover so the live app keeps working; they're dropped afterwards.
-- ═══════════════════════════════════════════════════════════════════════════

-- A share, as pushed by LPOS (full replace per share).
CREATE TABLE IF NOT EXISTS shares (
  id             TEXT PRIMARY KEY,           -- LPOS share id
  token          TEXT NOT NULL UNIQUE,       -- /s/{token}
  name           TEXT NOT NULL,
  audience       TEXT NOT NULL CHECK (audience IN ('link','email','staff')),
  caps           TEXT NOT NULL,              -- json ShareCaps
  revoked        INTEGER NOT NULL DEFAULT 0,
  legacy_hub_id  TEXT,                       -- converted Link Hub → /h/{id} redirects here
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_shares_legacy ON shares(legacy_hub_id);

CREATE TABLE IF NOT EXISTS share_emails (
  share_id  TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  email     TEXT NOT NULL,                   -- lowercased
  PRIMARY KEY (share_id, email)
);
CREATE INDEX IF NOT EXISTS idx_share_emails_email ON share_emails(email);

-- The videos in a share, fully resolved by LPOS (title, stream, downloads, transcript).
CREATE TABLE IF NOT EXISTS share_items (
  share_id       TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  asset_id       TEXT NOT NULL,
  video_token    TEXT NOT NULL UNIQUE,       -- /v/{video_token}
  position       INTEGER NOT NULL DEFAULT 0,
  title          TEXT NOT NULL,
  lpos_name      TEXT NOT NULL,
  section        TEXT,
  duration_s     REAL,
  hls_url        TEXT,
  thumbnail_url  TEXT,
  download       TEXT,                       -- json, null while Download is off
  transcript     TEXT,                       -- json cues, null while Transcript is off
  PRIMARY KEY (share_id, asset_id)
);
CREATE INDEX IF NOT EXISTS idx_share_items_token ON share_items(video_token);

-- Comments. A thread belongs to the share it was started in (share_id), so two
-- clients shown the same video never see each other's comments. LPOS is the
-- source of truth: rows with lpos_id came from (or were acknowledged by) LPOS;
-- rows without one were made here and are waiting for LPOS to pull them.
CREATE TABLE IF NOT EXISTS comments (
  id           TEXT PRIMARY KEY,             -- this app's id
  share_id     TEXT NOT NULL,
  asset_id     TEXT NOT NULL,
  lpos_id      TEXT UNIQUE,
  parent_id    TEXT,                         -- this app's id of the thread root (null = top-level)
  author_name  TEXT NOT NULL,
  author_kind  TEXT NOT NULL CHECK (author_kind IN ('guest','email','staff','frameio')),
  guest_id     TEXT,
  email        TEXT,
  staff_uid    TEXT,
  text         TEXT NOT NULL,
  timestamp_s  REAL,
  duration_s   REAL,
  completed    INTEGER NOT NULL DEFAULT 0,
  internal     INTEGER NOT NULL DEFAULT 0,
  origin       TEXT NOT NULL CHECK (origin IN ('share','lpos')),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_comments_thread ON comments(share_id, asset_id, created_at);

-- Changes made here, for LPOS to pull (GET /api/lpos/changes?since=seq).
CREATE TABLE IF NOT EXISTS comment_events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id  TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('create','edit','delete','complete','uncomplete')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Staff tickets already used (single use). Pruned after a day.
CREATE TABLE IF NOT EXISTS staff_tickets_used (
  jti      TEXT PRIMARY KEY,
  used_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
