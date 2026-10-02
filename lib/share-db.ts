import 'server-only';
import { randomUUID } from 'node:crypto';
import { db } from './db';
import type {
  CommentChange, CommentRow, LposComment, Share, ShareCaps, ShareItem, SharePayload,
} from './types';

/**
 * LP Share store. Shares and their videos are a projection LPOS pushes here
 * (full replace per share). Comments are two-way: LPOS pushes each asset's set;
 * changes made here are logged as events for LPOS to pull.
 */

const NO_CAPS: ShareCaps = { comments: false, download: false, reshare: false, transcripts: false, player: true, internal: false };

interface ShareRowDb { id: string; token: string; name: string; audience: string; caps: string; revoked: number; legacy_hub_id: string | null; updated_at: string }
interface ItemRowDb extends Omit<ShareItem, 'download' | 'transcript'> { download: string | null; transcript: string | null }

function parseJson<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

function toShare(r: ShareRowDb): Share {
  return {
    id: r.id, token: r.token, name: r.name,
    audience: r.audience === 'email' || r.audience === 'staff' ? r.audience : 'link',
    caps: { ...NO_CAPS, ...parseJson<Partial<ShareCaps>>(r.caps, {}) },
    revoked: !!r.revoked, legacy_hub_id: r.legacy_hub_id, updated_at: r.updated_at,
  };
}

function toItem(r: ItemRowDb): ShareItem {
  return { ...r, download: parseJson(r.download, null), transcript: parseJson(r.transcript, null) };
}

// ── Reads ────────────────────────────────────────────────────────────────────

export function getShareByToken(token: string): Share | null {
  const r = db().prepare('SELECT * FROM shares WHERE token = ?').get(token) as ShareRowDb | undefined;
  return r ? toShare(r) : null;
}

export function getShareById(id: string): Share | null {
  const r = db().prepare('SELECT * FROM shares WHERE id = ?').get(id) as ShareRowDb | undefined;
  return r ? toShare(r) : null;
}

export function getShareByLegacyHub(hubId: string): Share | null {
  const r = db().prepare('SELECT * FROM shares WHERE legacy_hub_id = ?').get(hubId) as ShareRowDb | undefined;
  return r ? toShare(r) : null;
}

export function shareItems(shareId: string): ShareItem[] {
  return (db().prepare('SELECT * FROM share_items WHERE share_id = ? ORDER BY position').all(shareId) as ItemRowDb[]).map(toItem);
}

export function itemByVideoToken(videoToken: string): { share: Share; item: ShareItem } | null {
  const r = db().prepare('SELECT * FROM share_items WHERE video_token = ?').get(videoToken) as ItemRowDb | undefined;
  if (!r) return null;
  const share = getShareById(r.share_id);
  return share ? { share, item: toItem(r) } : null;
}

export function shareEmails(shareId: string): string[] {
  return (db().prepare('SELECT email FROM share_emails WHERE share_id = ? ORDER BY email').all(shareId) as Array<{ email: string }>).map((r) => r.email);
}

export function emailOnShare(shareId: string, email: string): boolean {
  return !!db().prepare('SELECT 1 FROM share_emails WHERE share_id = ? AND email = ?').get(shareId, email.toLowerCase());
}

/** Live (not revoked) shares addressed to an email — the signed-in home. */
export function sharesForEmail(email: string): Array<Share & { video_count: number }> {
  const rows = db().prepare(
    `SELECT s.*, (SELECT COUNT(*) FROM share_items i WHERE i.share_id = s.id) AS video_count
     FROM shares s JOIN share_emails e ON e.share_id = s.id
     WHERE e.email = ? AND s.revoked = 0 AND s.audience = 'email'
     ORDER BY s.updated_at DESC`,
  ).all(email.toLowerCase()) as Array<ShareRowDb & { video_count: number }>;
  return rows.map((r) => ({ ...toShare(r), video_count: r.video_count }));
}

// ── LPOS push: shares ─────────────────────────────────────────────────────────

export function upsertShareFromLpos(p: SharePayload): void {
  const conn = db();
  conn.transaction(() => {
    conn.prepare(
      `INSERT INTO shares (id, token, name, audience, caps, revoked, legacy_hub_id, updated_at)
       VALUES (@id, @token, @name, @audience, @caps, @revoked, @legacy_hub_id, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         token = excluded.token, name = excluded.name, audience = excluded.audience,
         caps = excluded.caps, revoked = excluded.revoked, legacy_hub_id = excluded.legacy_hub_id,
         updated_at = datetime('now')`,
    ).run({
      id: p.share.id, token: p.share.token, name: p.share.name, audience: p.share.audience,
      caps: JSON.stringify({ ...NO_CAPS, ...p.share.caps }), revoked: p.share.revoked ? 1 : 0,
      legacy_hub_id: p.share.legacy_hub_id ?? null,
    });

    conn.prepare('DELETE FROM share_emails WHERE share_id = ?').run(p.share.id);
    const insEmail = conn.prepare('INSERT OR IGNORE INTO share_emails (share_id, email) VALUES (?, ?)');
    for (const e of p.emails) if (e.trim()) insEmail.run(p.share.id, e.trim().toLowerCase());

    conn.prepare('DELETE FROM share_items WHERE share_id = ?').run(p.share.id);
    // A token that moved here from another share (shouldn't happen, but a stale
    // row must never block a push) is released first.
    const release = conn.prepare('DELETE FROM share_items WHERE video_token = ? AND share_id != ?');
    const insItem = conn.prepare(
      `INSERT INTO share_items (share_id, asset_id, video_token, position, title, lpos_name, section,
                                duration_s, hls_url, thumbnail_url, download, transcript)
       VALUES (@share_id, @asset_id, @video_token, @position, @title, @lpos_name, @section,
               @duration_s, @hls_url, @thumbnail_url, @download, @transcript)`,
    );
    p.items.forEach((it, i) => {
      release.run(it.video_token, p.share.id);
      insItem.run({
        share_id: p.share.id, asset_id: it.asset_id, video_token: it.video_token, position: i,
        title: it.title, lpos_name: it.lpos_name, section: it.section ?? null,
        duration_s: it.duration_s ?? null, hls_url: it.hls_url ?? null, thumbnail_url: it.thumbnail_url ?? null,
        download: it.download ? JSON.stringify(it.download) : null,
        transcript: it.transcript ? JSON.stringify(it.transcript) : null,
      });
    });
  })();
}

export function deleteShare(shareId: string): void {
  const conn = db();
  conn.transaction(() => {
    conn.prepare('DELETE FROM share_items WHERE share_id = ?').run(shareId);
    conn.prepare('DELETE FROM share_emails WHERE share_id = ?').run(shareId);
    conn.prepare('DELETE FROM comments WHERE share_id = ?').run(shareId);
    conn.prepare('DELETE FROM share_activity WHERE share_id = ?').run(shareId);
    conn.prepare('DELETE FROM shares WHERE id = ?').run(shareId);
  })();
}

// ── Comments: reads ───────────────────────────────────────────────────────────

/** A share's comments on one video (top-level + replies), oldest first. */
export function listComments(shareId: string, assetId: string, opts: { includeInternal: boolean }): CommentRow[] {
  const rows = db().prepare(
    `SELECT * FROM comments WHERE share_id = ? AND asset_id = ? AND deleted_at IS NULL
     ORDER BY created_at, id`,
  ).all(shareId, assetId) as CommentRow[];
  if (opts.includeInternal) return rows;
  const hidden = new Set(rows.filter((r) => r.internal && !r.parent_id).map((r) => r.id));
  return rows.filter((r) => !r.internal && !(r.parent_id && hidden.has(r.parent_id)));
}

export function getComment(id: string): CommentRow | null {
  return (db().prepare('SELECT * FROM comments WHERE id = ?').get(id) as CommentRow | undefined) ?? null;
}

// ── Comments: writes made here (each logs an event for LPOS to pull) ─────────

function logEvent(commentId: string, kind: CommentChange['kind']): void {
  db().prepare('INSERT INTO comment_events (comment_id, kind) VALUES (?, ?)').run(commentId, kind);
}

export interface NewComment {
  share_id: string; asset_id: string; parent_id: string | null;
  author_name: string; author_kind: 'guest' | 'email' | 'staff';
  guest_id: string | null; email: string | null; staff_uid: string | null;
  text: string; timestamp_s: number | null; duration_s: number | null; internal: boolean;
}

export function createComment(c: NewComment): CommentRow {
  const conn = db();
  const id = randomUUID();
  const now = new Date().toISOString();
  conn.transaction(() => {
    conn.prepare(
      `INSERT INTO comments (id, share_id, asset_id, lpos_id, parent_id, author_name, author_kind, guest_id, email,
                             staff_uid, text, timestamp_s, duration_s, completed, internal, origin, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'share', ?, ?)`,
    ).run(id, c.share_id, c.asset_id, c.parent_id, c.author_name, c.author_kind, c.guest_id, c.email,
      c.staff_uid, c.text, c.parent_id ? null : c.timestamp_s, c.parent_id ? null : c.duration_s,
      c.internal ? 1 : 0, now, now);
    logEvent(id, 'create');
  })();
  return getComment(id)!;
}

export function editComment(id: string, text: string): void {
  const conn = db();
  conn.transaction(() => {
    conn.prepare('UPDATE comments SET text = ?, updated_at = ? WHERE id = ?').run(text, new Date().toISOString(), id);
    logEvent(id, 'edit');
  })();
}

export function deleteComment(id: string): void {
  const conn = db();
  conn.transaction(() => {
    const now = new Date().toISOString();
    conn.prepare('UPDATE comments SET deleted_at = ?, updated_at = ? WHERE id = ? OR parent_id = ?').run(now, now, id, id);
    logEvent(id, 'delete');
  })();
}

export function setCommentCompleted(id: string, completed: boolean): void {
  const conn = db();
  conn.transaction(() => {
    conn.prepare('UPDATE comments SET completed = ?, updated_at = ? WHERE id = ?').run(completed ? 1 : 0, new Date().toISOString(), id);
    logEvent(id, completed ? 'complete' : 'uncomplete');
  })();
}

// ── Comments: LPOS pull + ack ─────────────────────────────────────────────────

export function changesSince(since: number, limit = 500): { changes: CommentChange[]; cursor: number } {
  const conn = db();
  const events = conn.prepare('SELECT seq, comment_id, kind FROM comment_events WHERE seq > ? ORDER BY seq LIMIT ?')
    .all(since, limit) as Array<{ seq: number; comment_id: string; kind: CommentChange['kind'] }>;
  const changes: CommentChange[] = [];
  for (const e of events) {
    const c = getComment(e.comment_id);
    if (!c) continue;
    const parent = c.parent_id ? getComment(c.parent_id) : null;
    changes.push({
      seq: e.seq,
      kind: e.kind,
      comment: {
        share_comment_id: c.id, lpos_id: c.lpos_id, share_id: c.share_id, asset_id: c.asset_id,
        parent_share_comment_id: c.parent_id, parent_lpos_id: parent?.lpos_id ?? null,
        author_name: c.author_name, author_kind: c.author_kind,
        guest_id: c.guest_id, email: c.email, staff_uid: c.staff_uid,
        text: c.text, timestamp_s: c.timestamp_s, duration_s: c.duration_s,
        completed: !!c.completed, internal: !!c.internal, created_at: c.created_at, deleted: !!c.deleted_at,
      },
    });
  }
  return { changes, cursor: events.length ? events[events.length - 1].seq : since };
}

/** LPOS has applied every event up to `cursor`; record the LPOS ids it assigned. */
export function ackChanges(cursor: number, mapped: Array<{ share_comment_id: string; lpos_id: string }>): void {
  const conn = db();
  conn.transaction(() => {
    const setId = conn.prepare('UPDATE comments SET lpos_id = ? WHERE id = ? AND (lpos_id IS NULL OR lpos_id = ?)');
    for (const m of mapped) setId.run(m.lpos_id, m.share_comment_id, m.lpos_id);
    conn.prepare('DELETE FROM comment_events WHERE seq <= ?').run(cursor);
  })();
}

// ── Comments: LPOS push (an asset's full set) ─────────────────────────────────

/**
 * Replace the LPOS-known comments on an asset with LPOS's set. Rows made here
 * that LPOS hasn't picked up yet (no lpos_id, or with events still pending) are
 * left alone so nothing a client just typed disappears.
 */
export function replaceAssetCommentsFromLpos(assetId: string, set: LposComment[]): void {
  const conn = db();
  conn.transaction(() => {
    const pending = new Set((conn.prepare(
      `SELECT DISTINCT c.id FROM comment_events e JOIN comments c ON c.id = e.comment_id WHERE c.asset_id = ?`,
    ).all(assetId) as Array<{ id: string }>).map((r) => r.id));

    const byLpos = conn.prepare('SELECT * FROM comments WHERE lpos_id = ?');
    const upd = conn.prepare(
      `UPDATE comments SET lpos_id = @lpos_id, share_id = @share_id, parent_id = @parent_id, author_name = @author_name,
         author_kind = @author_kind, guest_id = COALESCE(@guest_id, guest_id), email = COALESCE(@email, email),
         staff_uid = COALESCE(@staff_uid, staff_uid), text = @text, timestamp_s = @timestamp_s, duration_s = @duration_s,
         completed = @completed, internal = @internal, created_at = @created_at, updated_at = @now, deleted_at = NULL
       WHERE id = @id`,
    );
    const ins = conn.prepare(
      `INSERT INTO comments (id, share_id, asset_id, lpos_id, parent_id, author_name, author_kind, guest_id, email, staff_uid,
                             text, timestamp_s, duration_s, completed, internal, origin, created_at, updated_at)
       VALUES (@id, @share_id, @asset_id, @lpos_id, @parent_id, @author_name, @author_kind, @guest_id, @email, @staff_uid,
               @text, @timestamp_s, @duration_s, @completed, @internal, 'lpos', @created_at, @now)`,
    );

    const now = new Date().toISOString();
    const seen = new Set<string>();
    // Parents first so replies can find their thread root's id here.
    const ordered = [...set].sort((a, b) => Number(!!a.parent_lpos_id) - Number(!!b.parent_lpos_id));
    for (const c of ordered) {
      const existing = (byLpos.get(c.lpos_id) as CommentRow | undefined)
        ?? (c.share_comment_id ? getComment(c.share_comment_id) : null);
      if (existing && pending.has(existing.id)) { seen.add(existing.id); continue; }   // local change not pulled yet
      const parent = c.parent_lpos_id ? byLpos.get(c.parent_lpos_id) as CommentRow | undefined : undefined;
      const row = {
        lpos_id: c.lpos_id, share_id: c.share_id, parent_id: parent?.id ?? null,
        author_name: c.author_name, author_kind: c.author_kind,
        guest_id: c.guest_id ?? null, email: c.email ?? null, staff_uid: c.staff_uid ?? null,
        text: c.text, timestamp_s: c.timestamp_s, duration_s: c.duration_s,
        completed: c.completed ? 1 : 0, internal: c.internal ? 1 : 0, created_at: c.created_at, now,
      };
      if (existing) { upd.run({ ...row, id: existing.id }); seen.add(existing.id); }
      else { const id = c.share_comment_id ?? randomUUID(); ins.run({ ...row, id, asset_id: assetId }); seen.add(id); }
    }

    // Anything LPOS knew about but no longer lists was deleted there.
    const known = conn.prepare('SELECT id FROM comments WHERE asset_id = ? AND lpos_id IS NOT NULL AND deleted_at IS NULL')
      .all(assetId) as Array<{ id: string }>;
    const del = conn.prepare('UPDATE comments SET deleted_at = ?, updated_at = ? WHERE id = ?');
    for (const r of known) if (!seen.has(r.id) && !pending.has(r.id)) del.run(now, now, r.id);
  })();
}

// ── Staff tickets (single use) ────────────────────────────────────────────────

/** True the first time a ticket id is seen; false if it was already used. */
export function useStaffTicket(jti: string): boolean {
  const conn = db();
  conn.prepare("DELETE FROM staff_tickets_used WHERE used_at < datetime('now', '-1 day')").run();
  return conn.prepare('INSERT OR IGNORE INTO staff_tickets_used (jti) VALUES (?)').run(jti).changes === 1;
}
