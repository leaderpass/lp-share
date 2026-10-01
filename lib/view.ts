import 'server-only';
import { listComments, shareItems } from './share-db';
import type { CommentRow, Share, ShareCaps, ShareItem } from './types';
import type { Viewer } from './viewer';

/**
 * What the browser gets for a share. Never includes R2 keys, other shares'
 * data, or (for non-staff) LPOS names and internal comments.
 */

export interface ViewItem {
  assetId: string;
  videoToken: string;
  title: string;
  /** LPOS asset name — staff only (null for everyone else). */
  lposName: string | null;
  duration: number | null;
  hlsUrl: string | null;
  thumbnailUrl: string | null;
  download: null | {
    state: 'preparing' | 'ready' | 'failed';
    progress: number;
    error: string | null;
    original: { size: number } | null;
    web: { size: number } | null;
    transcripts: Array<'srt' | 'vtt' | 'txt'>;
  };
  hasTranscript: boolean;
}

export interface ViewGroup { title: string | null; items: ViewItem[] }

export interface ViewModel {
  share: { token: string; name: string; caps: ShareCaps; audience: Share['audience'] };
  groups: ViewGroup[];
  viewer: {
    staff: { name: string } | null;
    email: string | null;
  };
}

function toViewItem(it: ShareItem, share: Share, staff: boolean): ViewItem {
  const d = share.caps.download ? it.download : null;
  return {
    assetId: it.asset_id,
    videoToken: it.video_token,
    title: it.title,
    lposName: staff ? it.lpos_name : null,
    duration: it.duration_s,
    hlsUrl: it.hls_url,
    thumbnailUrl: it.thumbnail_url,
    download: d ? {
      state: d.state, progress: d.progress, error: d.error,
      original: d.original ? { size: d.original.size } : null,
      web: d.web ? { size: d.web.size } : null,
      transcripts: share.caps.transcripts ? d.transcripts.map((t) => t.kind) : [],
    } : null,
    hasTranscript: share.caps.transcripts && !!it.transcript?.length,
  };
}

export function buildViewModel(share: Share, v: Viewer): ViewModel {
  const staff = !!v.staff;
  const groups: ViewGroup[] = [];
  for (const it of shareItems(share.id)) {
    const item = toViewItem(it, share, staff);
    const last = groups[groups.length - 1];
    if (last && last.title === it.section) last.items.push(item);
    else groups.push({ title: it.section, items: [item] });
  }
  return {
    share: { token: share.token, name: share.name, caps: share.caps, audience: share.audience },
    groups,
    viewer: { staff: v.staff ? { name: v.staff.name } : null, email: v.email },
  };
}

/** A single-video (/v/) view: playback only, never the parent share's token or name. */
export function buildVideoViewModel(share: Share, item: ShareItem, v: Viewer): ViewModel {
  const none: ShareCaps = { comments: false, download: false, reshare: false, transcripts: false, player: true, internal: false };
  const bare: Share = { ...share, caps: none };
  return {
    share: { token: '', name: item.title, caps: none, audience: 'link' },
    groups: [{ title: null, items: [{ ...toViewItem(item, bare, false) }] }],
    viewer: { staff: v.staff ? { name: v.staff.name } : null, email: v.email },
  };
}

// ── Comments as the browser sees them ────────────────────────────────────────

export interface ViewComment {
  id: string;
  parentId: string | null;
  authorName: string;
  authorKind: CommentRow['author_kind'];
  text: string;
  timestamp: number | null;
  duration: number | null;
  completed: boolean;
  internal: boolean;
  createdAt: string;
  canEdit: boolean;
  canDelete: boolean;
  /** Not in LPOS yet (made here, waiting to be pulled). */
  pending: boolean;
}

export function isOwnComment(c: CommentRow, v: Viewer): boolean {
  if (v.staff) return c.author_kind === 'staff' && c.staff_uid === v.staff.uid;
  if (c.author_kind === 'guest') return !!v.guestId && c.guest_id === v.guestId;
  if (c.author_kind === 'email') return !!v.email && c.email === v.email;
  return false;
}

export function viewComments(share: Share, assetId: string, v: Viewer): ViewComment[] {
  const includeInternal = !!v.staff;
  return listComments(share.id, assetId, { includeInternal }).map((c) => {
    const own = isOwnComment(c, v);
    return {
      id: c.id, parentId: c.parent_id, authorName: c.author_name, authorKind: c.author_kind,
      text: c.text, timestamp: c.timestamp_s, duration: c.duration_s,
      completed: !!c.completed, internal: !!c.internal, createdAt: c.created_at,
      canEdit: own, canDelete: own || !!v.staff, pending: !c.lpos_id,
    };
  });
}
