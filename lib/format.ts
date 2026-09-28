/** SMPTE HH:MM:SS:FF at 24 fps with the 01:00:00:00 start offset (matches LPOS comment timecodes). */
export function formatTimecode(seconds: number): string {
  const F = Math.round(seconds * 24) + 86400;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(F / 86400))}:${p(Math.floor(F / 1440) % 60)}:${p(Math.floor(F / 24) % 60)}:${p(F % 24)}`;
}

/** 3:18 / 1:02:04 */
export function formatDuration(s: number | null | undefined): string {
  if (!s || !isFinite(s) || s <= 0) return '';
  const t = Math.round(s);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

export function formatBytes(n: number): string {
  if (!n) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

export function formatCommentDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
