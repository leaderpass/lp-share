/**
 * Pure helpers for the review bar (components/ReviewBar.tsx): grouping comment
 * markers that sit too close to tell apart, stacking them in the zoomed loupe,
 * and reading a typed timecode. Kept free of React so LPOS can copy it as-is.
 */

export interface BarMarker {
  id: string;
  timestamp: number | null;
  duration: number | null;
  completed: boolean;
  authorName: string;
  text: string;
}

export interface MarkerCluster {
  /** Stable while the group's first marker stays first (the loupe keys on it). */
  key: string;
  ids: string[];
  /** Pill position on the bar, percent. */
  x: number;
  /** Time window the loupe zooms to. */
  lo: number;
  hi: number;
}

/** Markers whose start points are closer than this many pixels merge into one pill. */
export const CLUSTER_PX = 10;
const LOUPE_MIN_S = 4;

/** Group timed markers left to right; a group of one is drawn as a plain tick. */
export function buildClusters(markers: BarMarker[], duration: number, widthPx: number): MarkerCluster[] {
  if (!(duration > 0) || !(widthPx > 0)) return [];
  const timed = markers.filter((m) => m.timestamp !== null).sort((a, b) => a.timestamp! - b.timestamp!);
  const groups: { ms: BarMarker[]; firstX: number; lastX: number }[] = [];
  for (const m of timed) {
    const x = (m.timestamp! / duration) * widthPx;
    const last = groups[groups.length - 1];
    if (last && x - last.lastX < CLUSTER_PX) { last.ms.push(m); last.lastX = x; }
    else groups.push({ ms: [m], firstX: x, lastX: x });
  }
  return groups.map((g) => {
    const a = Math.min(...g.ms.map((m) => m.timestamp!));
    const b = Math.max(...g.ms.map((m) => m.timestamp! + (m.duration ?? 0)));
    const pad = Math.max(1, (b - a) * 0.2);
    let lo = Math.max(0, a - pad);
    let hi = Math.min(duration, b + pad);
    if (hi - lo < LOUPE_MIN_S) {
      const mid = (lo + hi) / 2;
      lo = Math.max(0, mid - LOUPE_MIN_S / 2);
      hi = Math.min(duration, lo + LOUPE_MIN_S);
    }
    return { key: g.ms[0].id, ids: g.ms.map((m) => m.id), x: ((g.firstX + g.lastX) / 2 / widthPx) * 100, lo, hi };
  });
}

/**
 * Row per marker so loupe chips never overlap: each marker takes the first row
 * whose last occupant ended before it starts. `startPct`/`endPct` are already in
 * loupe percent; `chipPct` is a chip's width in the same units.
 */
export function stackRows(items: { startPct: number; endPct: number }[], chipPct: number): { rows: number[]; count: number } {
  const ends: number[] = [];
  const rows = items.map(({ startPct, endPct }) => {
    const a = startPct - chipPct / 2;
    const b = Math.max(endPct, startPct + chipPct / 2) + 1;
    let r = ends.findIndex((end) => end < a);
    if (r === -1) { r = ends.length; ends.push(b); } else ends[r] = b;
    return r;
  });
  return { rows, count: ends.length };
}

/**
 * Read a typed time, in seconds. Accepts the SMPTE form comments show
 * (01:00:52:05, with its one-hour start offset), MM:SS:FF, M:SS, or plain seconds.
 * Returns null when it can't be read.
 */
export function parseTimecode(raw: string, fps = 24): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const parts = s.split(/[:;.]/).map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
  if (parts.some((n) => !isFinite(n))) return null;
  let h = 0, m = 0, sec = 0, f = 0;
  if (parts.length === 4) { [h, m, sec, f] = parts; h = Math.max(0, h - 1); }
  else if (parts.length === 3) { [m, sec, f] = parts; }
  else if (parts.length === 2) { [m, sec] = parts; }
  else return null;
  if (sec >= 60 || m >= 60 || f >= fps) return null;
  return h * 3600 + m * 60 + sec + f / fps;
}
