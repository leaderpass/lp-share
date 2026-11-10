/**
 * Comment span drafted in a compose box: `start` is the in-point, `end` the
 * out-point (null = a single-moment comment). Seconds, NDF-frame snapped.
 */
export interface CommentSpan {
  start: number;
  end:   number | null;
}

const FRAME = 1 / 24;

/** Round a playhead time to the nearest NDF frame boundary (real seconds → frame → NDF seconds). */
export function snapToFrame(t: number): number {
  return Math.round(t * 24000 / 1001) / 24;
}

/**
 * Span from a scrub-bar drag: one edge stays at `anchor`, the other follows
 * the pointer at `t`. Crossing the anchor flips the edges; collapsing to under
 * a frame drops back to a single moment.
 */
export function spanFromDrag(anchor: number, t: number): CommentSpan {
  const b = snapToFrame(t);
  if (Math.abs(b - anchor) < FRAME) return { start: anchor, end: null };
  return { start: Math.min(anchor, b), end: Math.max(anchor, b) };
}

/** Duration to post, or null for a single-moment comment. */
export function spanDuration(span: CommentSpan): number | null {
  return span.end !== null && span.end - span.start >= FRAME ? span.end - span.start : null;
}
