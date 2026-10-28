import 'server-only';
import { db } from './db';

/**
 * Client Upload Links store (spec §12). Links and their team files are LPOS's
 * projection; uploads, their change events and team-file downloads are made
 * here for LPOS to pull.
 */

export interface UploadLink {
  id: string; token: string; active: boolean;
  project_name: string; client_name: string; welcome_name: string | null;
}

export interface UploadRow {
  id: string; link_id: string; key: string; multipart_id: string; file_name: string; size: number; mime: string;
  part_size: number; uploader_name: string; guest_id: string | null; lpos_status: 'received' | 'added' | 'gone' | null;
  created_at: string; completed_at: string | null; removed_at: string | null; file_gone: number;
}

export interface TeamFileRow {
  id: string; link_id: string; key: string; file_name: string; size: number; mime: string; added_at: string; expires_at: string;
}

interface LinkRowDb { id: string; token: string; active: number; project_name: string; client_name: string; welcome_name: string | null }
const toLink = (r: LinkRowDb): UploadLink => ({ ...r, active: !!r.active });

export function getUploadLinkByToken(token: string): UploadLink | null {
  const r = db().prepare('SELECT * FROM upload_links WHERE token = ?').get(token) as LinkRowDb | undefined;
  return r ? toLink(r) : null;
}

export interface UploadLinkPayload {
  link: { id: string; token: string; active: boolean; project_name: string; client_name: string; welcome_name: string | null };
  /** `available` is absent from LPOS versions before team files: treat as true. */
  uploads: Array<{ upload_id: string; status: 'received' | 'added' | 'gone'; available?: boolean }>;
  /** Absent from LPOS versions before team files: leave the link's team files as they are. */
  team_files?: Array<{
    file_id: string; file_key: string; file_name: string; file_size: number; mime_type: string; added_at: string; expires_at: string;
  }>;
}

/** Full replace of one link from an LPOS push. A new token for the same id replaces the old one. */
export function upsertUploadLink(p: UploadLinkPayload): void {
  const conn = db();
  conn.transaction(() => {
    conn.prepare('DELETE FROM upload_links WHERE token = ? AND id <> ?').run(p.link.token, p.link.id);
    conn.prepare(
      `INSERT INTO upload_links (id, token, active, project_name, client_name, welcome_name, updated_at)
       VALUES (@id, @token, @active, @project_name, @client_name, @welcome_name, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET token = excluded.token, active = excluded.active, project_name = excluded.project_name,
         client_name = excluded.client_name, welcome_name = excluded.welcome_name, updated_at = excluded.updated_at`,
    ).run({ ...p.link, active: p.link.active ? 1 : 0, welcome_name: p.link.welcome_name ?? null });
    const set = conn.prepare('UPDATE uploads SET lpos_status = ?, file_gone = ? WHERE id = ? AND link_id = ?');
    for (const u of p.uploads) set.run(u.status, u.available === false ? 1 : 0, u.upload_id, p.link.id);
    if (p.team_files) {
      conn.prepare('DELETE FROM upload_team_files WHERE link_id = ?').run(p.link.id);
      const add = conn.prepare(
        `INSERT INTO upload_team_files (id, link_id, key, file_name, size, mime, added_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      );
      for (const f of p.team_files) add.run(f.file_id, p.link.id, f.file_key, f.file_name, f.file_size, f.mime_type, f.added_at, f.expires_at);
    }
  })();
}

export function createUploadRow(u: Omit<UploadRow, 'lpos_status' | 'completed_at' | 'removed_at' | 'file_gone'>): void {
  db().prepare(
    `INSERT INTO uploads (id, link_id, key, multipart_id, file_name, size, mime, part_size, uploader_name, guest_id, created_at)
     VALUES (@id, @link_id, @key, @multipart_id, @file_name, @size, @mime, @part_size, @uploader_name, @guest_id, @created_at)`,
  ).run(u);
}

export function getUploadRow(linkId: string, uploadId: string): UploadRow | null {
  return (db().prepare('SELECT * FROM uploads WHERE id = ? AND link_id = ?').get(uploadId, linkId) as UploadRow | undefined) ?? null;
}

/** Finished, not removed, not gone: what the page lists. */
export function listVisibleUploads(linkId: string): UploadRow[] {
  return db().prepare(
    `SELECT * FROM uploads WHERE link_id = ? AND completed_at IS NOT NULL AND removed_at IS NULL
       AND (lpos_status IS NULL OR lpos_status <> 'gone')
     ORDER BY completed_at DESC`,
  ).all(linkId) as UploadRow[];
}

/** Mark complete and emit `uploaded` (once). Returns false if it was already complete. */
export function markUploadComplete(uploadId: string): boolean {
  const conn = db();
  return conn.transaction(() => {
    const now = new Date().toISOString();
    const r = conn.prepare('UPDATE uploads SET completed_at = ? WHERE id = ? AND completed_at IS NULL').run(now, uploadId);
    if (r.changes !== 1) return false;
    conn.prepare(`INSERT INTO upload_events (upload_id, kind, created_at) VALUES (?, 'uploaded', ?)`).run(uploadId, now);
    return true;
  })();
}

/** The client removed a finished file: hide it and emit `removed`. */
export function markUploadRemoved(uploadId: string): boolean {
  const conn = db();
  return conn.transaction(() => {
    const now = new Date().toISOString();
    const r = conn.prepare('UPDATE uploads SET removed_at = ? WHERE id = ? AND removed_at IS NULL').run(now, uploadId);
    if (r.changes !== 1) return false;
    conn.prepare(`INSERT INTO upload_events (upload_id, kind, created_at) VALUES (?, 'removed', ?)`).run(uploadId, now);
    return true;
  })();
}

/** A cancelled, never-finished upload: no event (LPOS never heard of it). */
export function deleteUnfinishedUpload(uploadId: string): void {
  db().prepare('DELETE FROM uploads WHERE id = ? AND completed_at IS NULL').run(uploadId);
}

export interface UploadChange {
  seq: number; kind: 'uploaded' | 'removed'; at: string;
  upload: { upload_id: string; link_id: string; file_key: string; file_name: string; file_size: number; mime_type: string; uploader_name: string; uploaded_at: string };
}

export function uploadChangesSince(since: number, limit = 500): { changes: UploadChange[]; cursor: number } {
  const rows = db().prepare(
    `SELECT e.seq, e.kind, e.created_at AS at, u.* FROM upload_events e JOIN uploads u ON u.id = e.upload_id
     WHERE e.seq > ? ORDER BY e.seq LIMIT ?`,
  ).all(since, limit) as Array<UploadRow & { seq: number; kind: 'uploaded' | 'removed'; at: string }>;
  return {
    changes: rows.map((r) => ({
      seq: r.seq, kind: r.kind, at: r.at,
      upload: {
        upload_id: r.id, link_id: r.link_id, file_key: r.key, file_name: r.file_name, file_size: r.size,
        mime_type: r.mime, uploader_name: r.uploader_name, uploaded_at: r.completed_at ?? r.created_at,
      },
    })),
    cursor: rows.length ? rows[rows.length - 1].seq : since,
  };
}

export function ackUploadChanges(cursor: number): void {
  db().prepare('DELETE FROM upload_events WHERE seq <= ?').run(cursor);
}

// ── Team files (spec §12.6) ──────────────────────────────────────────────────

/** Team files the page offers now (not expired). */
export function listLiveTeamFiles(linkId: string): TeamFileRow[] {
  return db().prepare(
    `SELECT * FROM upload_team_files WHERE link_id = ? AND expires_at > ? ORDER BY added_at DESC`,
  ).all(linkId, new Date().toISOString()) as TeamFileRow[];
}

export function getLiveTeamFile(linkId: string, fileId: string): TeamFileRow | null {
  return (db().prepare(
    `SELECT * FROM upload_team_files WHERE id = ? AND link_id = ? AND expires_at > ?`,
  ).get(fileId, linkId, new Date().toISOString()) as TeamFileRow | undefined) ?? null;
}

/** Team-file ids this browser has downloaded (not New for it any more). */
export function seenFileIds(guestId: string | null): Set<string> {
  if (!guestId) return new Set();
  const rows = db().prepare('SELECT file_id FROM upload_file_seen WHERE guest_id = ?').all(guestId) as Array<{ file_id: string }>;
  return new Set(rows.map((r) => r.file_id));
}

/** A team file was downloaded: mark it seen for this browser and emit a download event for LPOS. */
export function recordTeamFileDownload(f: TeamFileRow, name: string, guestId: string | null): void {
  const conn = db();
  conn.transaction(() => {
    const now = new Date().toISOString();
    if (guestId) {
      conn.prepare('INSERT INTO upload_file_seen (file_id, guest_id, seen_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(f.id, guestId, now);
    }
    conn.prepare('INSERT INTO download_events (link_id, file_id, name, guest_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(f.link_id, f.id, name, guestId, now);
  })();
}

export interface DownloadChange { seq: number; link_id: string; file_id: string; name: string; guest_id: string | null; at: string }

export function downloadChangesSince(since: number, limit = 500): { changes: DownloadChange[]; cursor: number } {
  const rows = db().prepare(
    'SELECT seq, link_id, file_id, name, guest_id, created_at AS at FROM download_events WHERE seq > ? ORDER BY seq LIMIT ?',
  ).all(since, limit) as DownloadChange[];
  return { changes: rows, cursor: rows.length ? rows[rows.length - 1].seq : since };
}

export function ackDownloadChanges(cursor: number): void {
  db().prepare('DELETE FROM download_events WHERE seq <= ?').run(cursor);
}
