'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatCommentDate, formatTimecode } from '@/lib/format';

/**
 * A share's comments on one video — LPOS's AssetComments section ported for
 * LP Share. Rights come from the server (canEdit / canDelete); staff also get
 * complete + internal tags unless previewing as a client.
 */

export interface ViewComment {
  id: string;
  parentId: string | null;
  authorName: string;
  authorKind: 'guest' | 'email' | 'staff' | 'frameio';
  text: string;
  timestamp: number | null;
  duration: number | null;
  completed: boolean;
  internal: boolean;
  createdAt: string;
  canEdit: boolean;
  canDelete: boolean;
  pending: boolean;
}

interface Thread extends ViewComment { replies: ViewComment[] }

interface Props {
  token: string;
  assetId: string;
  staff: boolean;
  /** Staff previewing as a client: hide staff-only affordances. */
  clientView: boolean;
  internalShare: boolean;
  /** Current name from the name field; asking for one if it's empty. */
  getName: () => string;
  needsName: boolean;
  requestName: () => Promise<string | null>;
  getCurrentTime: () => number;
  onSeek: (t: number) => void;
  onComments: (c: ViewComment[]) => void;
}

const POLL_MS = 15_000;

function threads(list: ViewComment[]): Thread[] {
  const tops = list.filter((c) => !c.parentId).map((c) => ({ ...c, replies: [] as ViewComment[] }));
  const byId = new Map(tops.map((t) => [t.id, t]));
  for (const c of list) if (c.parentId) byId.get(c.parentId)?.replies.push(c);
  return tops;
}

const IconCheck = () => (<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>);
const IconEdit = () => (<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>);
const IconTrash = () => (<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4h6v2" /></svg>);

export function Comments({
  token, assetId, staff, clientView, internalShare, getName, needsName, requestName, getCurrentTime, onSeek, onComments,
}: Readonly<Props>) {
  const [list, setList] = useState<ViewComment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [composeText, setComposeText] = useState('');
  const [composeTime, setComposeTime] = useState(0);
  const [posting, setPosting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [replyingId, setReplyingId] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const onCommentsRef = useRef(onComments);
  onCommentsRef.current = onComments;

  const api = `/api/s/${token}/comments`;
  const apply = useCallback((c: ViewComment[]) => { setList(c); onCommentsRef.current(c); }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${api}?asset=${encodeURIComponent(assetId)}`, { cache: 'no-store' });
      const data = await res.json() as { comments?: ViewComment[]; error?: string };
      if (res.ok && data.comments) apply(data.comments);
    } catch { /* keep what we have */ }
  }, [api, assetId, apply]);

  useEffect(() => {
    setList(null); setError(null); setEditingId(null); setReplyingId(null); setComposeTime(0);
    void load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  /** Send a write; on "needs a name" ask once and retry. Returns true on success. */
  async function send(method: 'POST' | 'PATCH' | 'DELETE', body: Record<string, unknown>): Promise<boolean> {
    setError(null);
    let name = getName();
    if (method === 'POST' && needsName && !name.trim()) {
      const given = await requestName();
      if (!given) return false;
      name = given;
    }
    try {
      const res = await fetch(api, {
        method, headers: { 'content-type': 'application/json' },
        body: JSON.stringify(method === 'POST' ? { ...body, asset: assetId, name } : body),
      });
      const data = await res.json() as { comments?: ViewComment[]; error?: string; needName?: boolean };
      if (!res.ok) {
        if (data.needName) {
          const given = await requestName();
          if (given) return send(method, body);
          return false;
        }
        setError(data.error ?? 'Something went wrong.');
        return false;
      }
      if (data.comments) apply(data.comments);
      return true;
    } catch {
      setError('Couldn’t reach the server. Try again.');
      return false;
    }
  }

  async function post() {
    const text = composeText.trim();
    if (!text) return;
    setPosting(true);
    if (await send('POST', { text, timestamp: composeTime })) setComposeText('');
    setPosting(false);
  }
  async function saveEdit(id: string) {
    if (!editText.trim()) return;
    setBusyId(id);
    if (await send('PATCH', { id, text: editText.trim() })) { setEditingId(null); setEditText(''); }
    setBusyId(null);
  }
  async function reply(parentId: string) {
    if (!replyText.trim()) return;
    setBusyId(parentId);
    if (await send('POST', { text: replyText.trim(), parentId })) { setReplyingId(null); setReplyText(''); }
    setBusyId(null);
  }
  async function remove(id: string) {
    setBusyId(id);
    await send('DELETE', { id });
    setBusyId(null);
  }
  async function toggleComplete(c: ViewComment) {
    setBusyId(c.id);
    await send('PATCH', { id: c.id, completed: !c.completed });
    setBusyId(null);
  }

  const moderate = staff && !clientView;
  const all = threads((list ?? []).filter((c) => moderate || !c.internal || internalShare));

  function header(c: ViewComment, top: boolean) {
    return (
      <div className="mad-comment-header">
        <div className="mad-comment-avatar mad-comment-avatar--placeholder">{(c.authorName || '?')[0].toUpperCase()}</div>
        <span className="mad-comment-author">{c.authorName}</span>
        {moderate && c.internal && !internalShare && top && (
          <span className="mad-comment-source mad-comment-source--internal" title="Staff only — never shown to clients">Internal</span>
        )}
        <div className="mad-comment-meta">
          <span className="mad-comment-meta-spacer" aria-hidden="true" />
          {top && c.timestamp !== null && (
            <button type="button" className="mad-comment-time mad-comment-time--seek" title="Jump to this moment" onClick={() => onSeek(c.timestamp!)}>
              {formatTimecode(c.timestamp)}{c.duration ? ` → ${formatTimecode(c.timestamp + c.duration)}` : ''}
              <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" style={{ marginLeft: 3, opacity: 0.7 }}><polygon points="5 3 19 12 5 21 5 3" /></svg>
            </button>
          )}
          <span className="mad-comment-date">{formatCommentDate(c.createdAt)}</span>
        </div>
        {top && moderate && (
          <button type="button" className={`mad-comment-action mad-comment-check${c.completed ? ' mad-comment-check--done' : ''}`}
            onClick={() => void toggleComplete(c)} disabled={busyId === c.id}
            title={c.completed ? 'Mark incomplete' : 'Mark complete'} aria-label={c.completed ? 'Mark incomplete' : 'Mark complete'}>
            <IconCheck />
          </button>
        )}
        {c.canEdit && editingId !== c.id && (
          <button type="button" className="mad-comment-action" onClick={() => { setEditingId(c.id); setEditText(c.text); }} aria-label="Edit comment" title="Edit comment">
            <IconEdit />
          </button>
        )}
        {(c.canEdit || (c.canDelete && !clientView)) && (
          <button type="button" className="mad-comment-action mad-comment-action--danger" onClick={() => void remove(c.id)}
            disabled={busyId === c.id} aria-label="Delete comment" title="Delete comment">
            {busyId === c.id ? '…' : <IconTrash />}
          </button>
        )}
      </div>
    );
  }

  function body(c: ViewComment) {
    if (editingId !== c.id) return <p className="mad-comment-text">{c.text}</p>;
    return (
      <div className="mad-comment-edit">
        <textarea className="mad-comment-edit-input" value={editText} rows={2} autoFocus
          onChange={(e) => setEditText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void saveEdit(c.id); }
            if (e.key === 'Escape') { setEditingId(null); setEditText(''); }
          }} />
        <div className="mad-comment-edit-footer">
          <button type="button" className="mad-comment-trigger" onClick={() => { setEditingId(null); setEditText(''); }}>Cancel</button>
          <button type="button" className="mad-action-btn mad-action-btn--primary" onClick={() => void saveEdit(c.id)} disabled={!editText.trim() || busyId === c.id}>Save</button>
        </div>
      </div>
    );
  }

  return (
    <div className="mad-comments-section">
      {list === null && <p className="mad-comments-empty">Loading…</p>}
      {list !== null && all.length === 0 && <p className="mad-comments-empty">No comments yet.</p>}

      {all.length > 0 && (
        <div className="mad-comments-list">
          {all.map((c) => (
            <div key={c.id} className={`mad-comment${c.completed ? ' mad-comment--done' : ''}`}>
              {header(c, true)}
              {body(c)}
              {(c.replies.length > 0 || replyingId === c.id) && (
                <div className="mad-comment-replies">
                  {c.replies.map((r) => (
                    <div key={r.id} className="mad-comment-reply">
                      {header(r, false)}
                      {body(r)}
                    </div>
                  ))}
                  {replyingId === c.id && (
                    <div className="mad-reply-compose">
                      <input className="mad-reply-input" placeholder="Write a reply…" value={replyText} autoFocus
                        onChange={(e) => setReplyText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void reply(c.id); }
                          if (e.key === 'Escape') { setReplyingId(null); setReplyText(''); }
                        }} />
                      <div className="mad-reply-actions">
                        <button type="button" className="mad-comment-trigger" onClick={() => { setReplyingId(null); setReplyText(''); }}>Cancel</button>
                        <button type="button" className="mad-action-btn mad-action-btn--primary" onClick={() => void reply(c.id)} disabled={busyId === c.id || !replyText.trim()}>
                          {busyId === c.id ? '…' : 'Reply'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
              {replyingId !== c.id && (
                <button type="button" className="mad-comment-trigger mad-reply-btn" onClick={() => { setReplyingId(c.id); setReplyText(''); }}>Reply</button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="mad-comment-compose">
        <div className="mad-comment-compose-ts">@ {formatTimecode(composeTime)}</div>
        <div className="mad-comment-compose-row">
          <input
            className="mad-comment-compose-input"
            placeholder={internalShare ? 'Add an internal comment…' : 'Add a comment…'}
            value={composeText}
            onFocus={() => setComposeTime(Math.round(getCurrentTime() * 24000 / 1001) / 24)}
            onChange={(e) => setComposeText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void post(); }
              if (e.key === 'Escape') { setComposeText(''); setError(null); (e.target as HTMLInputElement).blur(); }
            }}
          />
          <button type="button" className="mad-comment-compose-send" onClick={() => void post()} disabled={posting || !composeText.trim()} aria-label="Post comment">
            {posting ? '…' : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></svg>
            )}
          </button>
        </div>
        {error && <span className="mad-compose-err">{error}</span>}
      </div>
    </div>
  );
}
