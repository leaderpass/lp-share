import 'server-only';
import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Hub, LibraryVideo, IngestHubPayload } from './types';
import { SAMPLE_HUBS } from './seed';

let _db: Database.Database | null = null;

/** Lazily open the SQLite file, ensure the schema, and dev-seed if empty. */
export function db(): Database.Database {
  if (_db) return _db;
  const file = process.env.SHARE_DB || process.env.LINK_HUB_DB || join(process.cwd(), 'data', 'link-hub.sqlite');
  mkdirSync(dirname(file), { recursive: true });
  const conn = new Database(file);
  conn.pragma('foreign_keys = ON');
  const schema = readFileSync(join(process.cwd(), 'data', 'schema.sql'), 'utf8');
  conn.exec(schema);
  migrateSchema(conn);
  _db = conn; // set before seeding so upsertHubFromLpos() reuses this connection
  maybeSeed(conn);
  return conn;
}

/** Additive migrations for DBs created before a column existed. */
function migrateSchema(conn: Database.Database): void {
  const cols = conn.prepare("PRAGMA table_info('assets')").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'thumbnail_url')) {
    conn.exec('ALTER TABLE assets ADD COLUMN thumbnail_url TEXT');
  }
}

/**
 * Seed sample hubs when it's safe/useful:
 *  - LINK_HUB_DEMO=1 → always upsert the samples (idempotent), even in production,
 *    so a demo instance is populated for a walkthrough.
 *  - otherwise, dev only, and only when the DB is empty.
 */
function maybeSeed(conn: Database.Database): void {
  if (process.env.LINK_HUB_DEMO === '1') {
    for (const payload of SAMPLE_HUBS) upsertHubFromLpos(payload);
    return;
  }
  if (process.env.NODE_ENV === 'production') return;
  const { n } = conn.prepare(`SELECT COUNT(*) AS n FROM hubs`).get() as { n: number };
  if (n > 0) return;
  for (const payload of SAMPLE_HUBS) upsertHubFromLpos(payload);
}

// ── Reads ──────────────────────────────────────────────────────────────────

/** Hubs a given login email can access (0, 1, or many → drives the switcher). */
export function hubsForEmail(email: string): Hub[] {
  return db()
    .prepare(
      `SELECT h.* FROM hubs h
       JOIN hub_access_emails a ON a.hub_id = h.id
       WHERE a.email = ?
       ORDER BY h.updated_at DESC`,
    )
    .all(email.toLowerCase()) as Hub[];
}

export function getHub(hubId: string): Hub | undefined {
  return db().prepare(`SELECT * FROM hubs WHERE id = ?`).get(hubId) as Hub | undefined;
}

/** True if this email is allowed into this hub. */
export function emailCanAccess(hubId: string, email: string): boolean {
  const row = db()
    .prepare(`SELECT 1 FROM hub_access_emails WHERE hub_id = ? AND email = ?`)
    .get(hubId, email.toLowerCase());
  return !!row;
}

/** The videos in a hub, ready to render. */
export function hubVideos(hubId: string): LibraryVideo[] {
  return db()
    .prepare(
      `SELECT i.share_token AS token, i.client_title AS title,
              a.duration_s AS duration_s, a.cf_stream_uid AS cf_stream_uid,
              a.thumbnail_url AS thumbnail_url
       FROM hub_items i
       JOIN assets a ON a.id = i.asset_id
       WHERE i.hub_id = ?
       ORDER BY i.sort_order, i.client_title`,
    )
    .all(hubId) as LibraryVideo[];
}

/** Resolve a public share token → the one video it points at (for /v/[token]). */
export function videoByToken(token: string): LibraryVideo | undefined {
  return db()
    .prepare(
      `SELECT i.share_token AS token, i.client_title AS title,
              a.duration_s AS duration_s, a.cf_stream_uid AS cf_stream_uid,
              a.thumbnail_url AS thumbnail_url
       FROM hub_items i
       JOIN assets a ON a.id = i.asset_id
       WHERE i.share_token = ?`,
    )
    .get(token) as LibraryVideo | undefined;
}

export function recordView(token: string, referrer?: string): void {
  db().prepare(`INSERT INTO view_events (share_token, referrer) VALUES (?, ?)`).run(token, referrer ?? null);
}

// ── Write (ingest only — LPOS is the source of truth) ────────────────────────

/**
 * Full-replace one hub's projection from an LPOS push. Idempotent.
 * Called from POST /api/ingest after the shared-secret check.
 */
export function upsertHubFromLpos(p: IngestHubPayload): void {
  const conn = db();
  const tx = conn.transaction(() => {
    conn
      .prepare(
        `INSERT INTO hubs (id, name, owner_label, owner_type, updated_at)
         VALUES (@id, @name, @owner_label, @owner_type, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, owner_label = excluded.owner_label,
           owner_type = excluded.owner_type, updated_at = datetime('now')`,
      )
      .run(p.hub);

    // access — replace the set
    conn.prepare(`DELETE FROM hub_access_emails WHERE hub_id = ?`).run(p.hub.id);
    const insAccess = conn.prepare(`INSERT INTO hub_access_emails (hub_id, email) VALUES (?, ?)`);
    for (const email of p.access_emails) insAccess.run(p.hub.id, email.toLowerCase());

    // items + their assets — replace the set
    const insAsset = conn.prepare(
      `INSERT INTO assets (id, lpos_name, cf_stream_uid, duration_s, thumbnail_url, updated_at)
       VALUES (@id, @lpos_name, @cf_stream_uid, @duration_s, @thumbnail_url, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         lpos_name = excluded.lpos_name, cf_stream_uid = excluded.cf_stream_uid,
         duration_s = excluded.duration_s, thumbnail_url = excluded.thumbnail_url,
         updated_at = datetime('now')`,
    );
    conn.prepare(`DELETE FROM hub_items WHERE hub_id = ?`).run(p.hub.id);
    const insItem = conn.prepare(
      `INSERT INTO hub_items (hub_id, asset_id, client_title, share_token, sort_order)
       VALUES (@hub_id, @asset_id, @client_title, @share_token, @sort_order)`,
    );
    p.items.forEach((it, i) => {
      insAsset.run({
        id: it.asset_id,
        lpos_name: it.asset.lpos_name,
        cf_stream_uid: it.asset.cf_stream_uid,
        duration_s: it.asset.duration_s,
        thumbnail_url: it.asset.thumbnail_url ?? null,
      });
      insItem.run({
        hub_id: p.hub.id,
        asset_id: it.asset_id,
        client_title: it.client_title,
        share_token: it.share_token,
        sort_order: i,
      });
    });
  });
  tx();
}

/** Remove a hub and everything under it (called when LPOS deletes the hub). */
export function deleteHub(hubId: string): void {
  const conn = db();
  const tx = conn.transaction((id: string) => {
    conn.prepare('DELETE FROM hub_items WHERE hub_id = ?').run(id);
    conn.prepare('DELETE FROM hub_access_emails WHERE hub_id = ?').run(id);
    conn.prepare('DELETE FROM hubs WHERE id = ?').run(id);
  });
  tx(hubId);
}
