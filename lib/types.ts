export type OwnerType = 'client' | 'person' | 'leaderpass';

export interface Asset {
  id: string;
  lpos_name: string;
  cf_stream_uid: string;
  duration_s: number;
  thumbnail_url: string | null;
}

export interface Hub {
  id: string;
  name: string;
  owner_label: string;
  owner_type: OwnerType;
  updated_at: string;
}

export interface HubItem {
  hub_id: string;
  asset_id: string;
  client_title: string;
  share_token: string;
  sort_order: number;
}

/** A hub_item joined to its asset — the shape the library + player render. */
export interface LibraryVideo {
  token: string;
  title: string;
  duration_s: number;
  cf_stream_uid: string;
  thumbnail_url: string | null;
}

/** Payload LPOS pushes to POST /api/ingest on save. Full replace per hub. */
export interface IngestHubPayload {
  hub: {
    id: string;
    name: string;
    owner_label: string;
    owner_type: OwnerType;
  };
  access_emails: string[];
  items: Array<{
    asset_id: string;
    client_title: string;
    share_token: string;
    // asset fields so the client DB can mirror what it needs to play the video
    asset: {
      lpos_name: string;
      cf_stream_uid: string;
      duration_s: number;
      thumbnail_url?: string | null;
    };
  }>;
}

// ═══════════════════════════════════════════════════════════════════════════
// LP Share — see ../docs/share-app-spec.md §5–§7
// ═══════════════════════════════════════════════════════════════════════════

export type ShareAudience = 'link' | 'email' | 'staff';

export interface ShareCaps {
  comments: boolean;
  download: boolean;
  reshare: boolean;
  transcripts: boolean;
  /** Video player. Off = a plain list of videos to download. Missing (older LPOS) = on. */
  player: boolean;
  /** Staff-only share: internal comments shown, new ones stay internal. */
  internal: boolean;
}

export interface DownloadInfo {
  state: 'preparing' | 'ready' | 'failed';
  progress: number;
  error: string | null;
  original: { key: string; size: number; ext: string } | null;
  web: { key: string; size: number } | null;
  transcripts: Array<{ kind: 'srt' | 'vtt' | 'txt'; key: string }>;
}

export interface TranscriptCue { from_ms: number; text: string }

export interface Share {
  id: string;
  token: string;
  name: string;
  audience: ShareAudience;
  caps: ShareCaps;
  revoked: boolean;
  legacy_hub_id: string | null;
  updated_at: string;
}

export interface ShareItem {
  share_id: string;
  asset_id: string;
  video_token: string;
  position: number;
  title: string;
  lpos_name: string;
  section: string | null;
  duration_s: number | null;
  hls_url: string | null;
  thumbnail_url: string | null;
  download: DownloadInfo | null;
  transcript: TranscriptCue[] | null;
}

/** POST /api/lpos/shares — one share, full replace. */
export interface SharePayload {
  share: {
    id: string; token: string; name: string;
    audience: ShareAudience;
    caps: ShareCaps;
    revoked: boolean;
    legacy_hub_id?: string | null;
  };
  emails: string[];
  items: Array<{
    asset_id: string;
    video_token: string;
    title: string;
    lpos_name: string;
    section: string | null;
    duration_s: number | null;
    hls_url: string | null;
    thumbnail_url: string | null;
    download: DownloadInfo | null;
    transcript: TranscriptCue[] | null;
  }>;
}

export type AuthorKind = 'guest' | 'email' | 'staff' | 'frameio';

/** POST /api/lpos/comments — one comment in an asset's full set. */
export interface LposComment {
  lpos_id: string;
  parent_lpos_id: string | null;
  /** The share the thread started in; comments are only shown there. */
  share_id: string;
  /** Set when the comment was made here, so its author keeps edit rights. */
  share_comment_id: string | null;
  author_name: string;
  author_kind: AuthorKind;
  /** Who made it here (echoed back by LPOS so rights survive the round trip). */
  guest_id?: string | null;
  email?: string | null;
  staff_uid?: string | null;
  text: string;
  timestamp_s: number | null;
  duration_s: number | null;
  completed: boolean;
  internal: boolean;
  created_at: string;
}

export interface CommentRow {
  id: string;
  share_id: string;
  asset_id: string;
  lpos_id: string | null;
  parent_id: string | null;
  author_name: string;
  author_kind: AuthorKind;
  guest_id: string | null;
  email: string | null;
  staff_uid: string | null;
  text: string;
  timestamp_s: number | null;
  duration_s: number | null;
  completed: number;
  internal: number;
  origin: 'share' | 'lpos';
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** GET /api/lpos/changes — one change made here, with the comment as it is now. */
export interface CommentChange {
  seq: number;
  kind: 'create' | 'edit' | 'delete' | 'complete' | 'uncomplete';
  comment: {
    share_comment_id: string;
    lpos_id: string | null;
    share_id: string;
    asset_id: string;
    parent_share_comment_id: string | null;
    parent_lpos_id: string | null;
    author_name: string;
    author_kind: AuthorKind;
    guest_id: string | null;
    email: string | null;
    staff_uid: string | null;
    text: string;
    timestamp_s: number | null;
    duration_s: number | null;
    completed: boolean;
    internal: boolean;
    created_at: string;
    deleted: boolean;
  };
}
