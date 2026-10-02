import 'server-only';
import { headers } from 'next/headers';
import { db } from './db';
import { shareEmails, shareItems } from './share-db';
import type { Share } from './types';
import type { Viewer } from './viewer';

/**
 * Share activity: who opened a share, who opened a single-video link, who
 * downloaded what. Read by LPOS (Analytics panel + bell); LP Share shows none
 * of it to viewers.
 *
 *   - Staff are never recorded (that includes previewing as a client).
 *   - Link previews (Slack, iMessage…) never count: opens come from a beacon
 *     the page sends after it loads in a real browser (POST /api/seen), and
 *     known bot user agents are dropped as a backstop.
 *   - Two kinds of viewer, kept distinct everywhere:
 *       email   — signed in with an email (a person we can name)
 *       visitor — anyone else; one per browser (share_guest cookie)
 *   - The same viewer repeating an event within 30 min is one row, so 'open'
 *     rows read as visits.
 */

export type ActivityKind = 'open' | 'video_open' | 'download';
export type ViewerKind = 'visitor' | 'email';

const FOLD_WINDOW_MS = 30 * 60 * 1000;
const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|discord|slack|linkedin|skype|embedly|vkshare|pinterest|headless|lighthouse|curl|wget|python-requests/i;

interface ActivityRow {
  seq: number; share_id: string; kind: ActivityKind; asset_id: string | null; file_kind: string | null;
  viewer_kind: ViewerKind; viewer_id: string; name: string | null; first_visit: number; created_at: string;
}

function isBot(): boolean {
  try { return BOT_UA.test(headers().get('user-agent') ?? ''); } catch { return false; }
}

/** Record one event for a viewer (no-op for staff, bots and cookieless requests). */
export function recordActivity(share: Share, v: Viewer, e: { kind: ActivityKind; assetId?: string | null; fileKind?: string | null; name?: string | null }): void {
  if (v.staff || isBot()) return;
  const who = v.email ? { kind: 'email' as const, id: v.email.toLowerCase() } : v.guestId ? { kind: 'visitor' as const, id: v.guestId } : null;
  if (!who) return;
  const name = (e.name ?? '').trim().slice(0, 80) || null;
  const now = new Date();
  const conn = db();
  try {
    const recent = conn.prepare(
      `SELECT seq FROM share_activity
        WHERE share_id = ? AND viewer_id = ? AND kind = ? AND IFNULL(asset_id, '') = ? AND IFNULL(file_kind, '') = ? AND created_at >= ?
        ORDER BY seq DESC LIMIT 1`,
    ).get(share.id, who.id, e.kind, e.assetId ?? '', e.fileKind ?? '', new Date(now.getTime() - FOLD_WINDOW_MS).toISOString()) as { seq: number } | undefined;
    if (recent) {
      if (name) conn.prepare('UPDATE share_activity SET name = ? WHERE seq = ?').run(name, recent.seq);
      return;
    }
    const seenBefore = e.kind === 'open' && !!conn.prepare(
      `SELECT 1 FROM share_activity WHERE share_id = ? AND viewer_id = ? AND kind = 'open' LIMIT 1`,
    ).get(share.id, who.id);
    conn.prepare(
      `INSERT INTO share_activity (share_id, kind, asset_id, file_kind, viewer_kind, viewer_id, name, first_visit, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(share.id, e.kind, e.assetId ?? null, e.fileKind ?? null, who.kind, who.id, name,
      e.kind === 'open' && !seenBefore ? 1 : 0, now.toISOString());
  } catch (err) {
    // Analytics must never break viewing or downloading.
    console.warn('[activity] record failed:', (err as Error).message);
  }
}

// ── LPOS reads ───────────────────────────────────────────────────────────────

export interface ActivityViewer {
  kind: ViewerKind;
  /** The email for signed-in viewers; the typed name or "Visitor N" for visitors. */
  label: string;
  email: string | null;
  name: string | null;
  visits: number;
  videoLinkOpens: number;
  downloads: number;
  comments: number;
  firstAt: string;
  lastAt: string;
}

export interface ShareActivitySummary {
  totals: {
    visits: number; signedIn: number; visitors: number;
    videoLinkOpens: number; downloads: number; comments: number;
    firstAt: string | null; lastAt: string | null;
  };
  /** Specific-people shares: everyone on the list, opened or not. Empty otherwise. */
  invited: Array<{ email: string; opened: boolean; visits: number; firstAt: string | null; lastAt: string | null }>;
  viewers: ActivityViewer[];
  videos: Array<{ assetId: string; title: string; videoLinkOpens: number; downloads: number; comments: number }>;
  recent: Array<{ kind: ActivityKind; at: string; viewerKind: ViewerKind; viewer: string; assetTitle: string | null; fileKind: string | null }>;
}

export function shareActivitySummary(share: Share): ShareActivitySummary {
  const conn = db();
  const rows = conn.prepare('SELECT * FROM share_activity WHERE share_id = ? ORDER BY seq').all(share.id) as ActivityRow[];
  const comments = conn.prepare(
    `SELECT asset_id, author_kind, author_name, guest_id, email FROM comments
      WHERE share_id = ? AND deleted_at IS NULL AND author_kind IN ('guest', 'email')`,
  ).all(share.id) as Array<{ asset_id: string; author_kind: string; author_name: string; guest_id: string | null; email: string | null }>;
  const titles = new Map(shareItems(share.id).map((i) => [i.asset_id, i.title]));

  // Viewers, in order of first appearance (so "Visitor N" numbering is stable).
  const byId = new Map<string, ActivityViewer & { id: string }>();
  let visitorN = 0;
  for (const r of rows) {
    let v = byId.get(r.viewer_id);
    if (!v) {
      v = {
        id: r.viewer_id, kind: r.viewer_kind, label: '', email: r.viewer_kind === 'email' ? r.viewer_id : null, name: null,
        visits: 0, videoLinkOpens: 0, downloads: 0, comments: 0, firstAt: r.created_at, lastAt: r.created_at,
      };
      if (r.viewer_kind === 'visitor') v.label = `Visitor ${++visitorN}`;
      byId.set(r.viewer_id, v);
    }
    if (r.name) v.name = r.name;
    if (r.kind === 'open') v.visits += 1;
    else if (r.kind === 'video_open') v.videoLinkOpens += 1;
    else v.downloads += 1;
    v.lastAt = r.created_at;
  }
  for (const c of comments) {
    const v = byId.get(c.author_kind === 'email' ? (c.email ?? '').toLowerCase() : c.guest_id ?? '');
    if (!v) continue;
    v.comments += 1;
    if (!v.name) v.name = c.author_name;
  }
  const labels = new Map([...byId.values()].map((v) => [v.id, v.kind === 'email' ? v.email! : v.name ?? v.label]));
  const viewers = [...byId.values()]
    .map(({ id, ...v }) => ({ ...v, label: labels.get(id)! }))
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt));

  const opens = rows.filter((r) => r.kind === 'open');
  const invited = share.audience === 'email'
    ? shareEmails(share.id).map((email) => {
        const mine = opens.filter((r) => r.viewer_id === email);
        return { email, opened: mine.length > 0, visits: mine.length, firstAt: mine[0]?.created_at ?? null, lastAt: mine[mine.length - 1]?.created_at ?? null };
      }).sort((a, b) => Number(b.opened) - Number(a.opened) || (b.lastAt ?? '').localeCompare(a.lastAt ?? '') || a.email.localeCompare(b.email))
    : [];

  const videos = [...titles.entries()].map(([assetId, title]) => ({
    assetId, title,
    videoLinkOpens: rows.filter((r) => r.kind === 'video_open' && r.asset_id === assetId).length,
    downloads: rows.filter((r) => r.kind === 'download' && r.asset_id === assetId).length,
    comments: comments.filter((c) => c.asset_id === assetId).length,
  }));

  return {
    totals: {
      visits: opens.length,
      signedIn: viewers.filter((v) => v.kind === 'email').length,
      visitors: viewers.filter((v) => v.kind === 'visitor').length,
      videoLinkOpens: rows.filter((r) => r.kind === 'video_open').length,
      downloads: rows.filter((r) => r.kind === 'download').length,
      comments: comments.length,
      firstAt: rows[0]?.created_at ?? null,
      lastAt: rows[rows.length - 1]?.created_at ?? null,
    },
    invited,
    viewers,
    videos,
    recent: rows.slice(-40).reverse().map((r) => ({
      kind: r.kind, at: r.created_at, viewerKind: r.viewer_kind, viewer: labels.get(r.viewer_id) ?? 'Someone',
      assetTitle: r.asset_id ? titles.get(r.asset_id) ?? null : null, fileKind: r.file_kind,
    })),
  };
}

export interface FirstVisit { seq: number; share_id: string; viewer_kind: ViewerKind; viewer: string; at: string }

/**
 * First-ever opens of a share by each viewer since `since`, for LPOS's bell.
 * The cursor covers every row scanned, so LPOS never re-reads them.
 */
export function firstVisitsSince(since: number, limit = 500): { visits: FirstVisit[]; cursor: number } {
  const rows = db().prepare('SELECT * FROM share_activity WHERE seq > ? ORDER BY seq LIMIT ?').all(since, limit) as ActivityRow[];
  return {
    visits: rows.filter((r) => r.first_visit === 1).map((r) => ({
      seq: r.seq, share_id: r.share_id, viewer_kind: r.viewer_kind,
      viewer: r.viewer_kind === 'email' ? r.viewer_id : r.name ?? 'A visitor',
      at: r.created_at,
    })),
    cursor: rows.length ? rows[rows.length - 1].seq : since,
  };
}
