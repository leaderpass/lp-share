/**
 * Comment span: `start` is the in-point, `end` the out-point (null = a single
 * moment). Seconds, NDF-frame snapped. Used for the span being drafted in a
 * compose box and for dragging a posted comment's marker.
 */
export interface CommentSpan {
  start: number;
  end:   number | null;
}

export type SpanEdge = 'start' | 'end';

const FRAME = 1 / 24;

/** Round a playhead time to the nearest NDF frame boundary (real seconds → frame → NDF seconds). */
export function snapToFrame(t: number): number {
  return Math.round(t * 24000 / 1001) / 24;
}

/**
 * Drag one edge of a span to `t`; the other edge stays put and the edges never
 * cross. Dragging the out-point back onto the in-point makes a single moment
 * again; a single moment has no separate in-point, so dragging it pulls out an
 * out-point (to the right only).
 */
export function dragSpanEdge(span: CommentSpan, edge: SpanEdge, t: number, duration: number): CommentSpan {
  const max = duration > 0 ? duration : Infinity;
  const b = snapToFrame(Math.max(0, Math.min(max, t)));
  if (edge === 'end' || span.end === null) {
    return b - span.start < FRAME ? { start: span.start, end: null } : { start: span.start, end: b };
  }
  return { start: Math.max(0, Math.min(b, snapToFrame(span.end - FRAME))), end: span.end };
}

/** Duration to save, or null for a single-moment comment. */
export function spanDuration(span: CommentSpan): number | null {
  return span.end !== null && span.end - span.start >= FRAME ? span.end - span.start : null;
}

/** A posted comment's timestamp + duration as a span. */
export function spanOf(timestamp: number, duration: number | null): CommentSpan {
  return { start: timestamp, end: duration && duration > 0 ? timestamp + duration : null };
}
