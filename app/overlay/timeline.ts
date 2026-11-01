export type TimelineSnapshot = {
  props: {
    title: string;
    artist: string;
    album_title?: string | null;
  };
  is_playing: boolean;
  position_ms?: number | null;
  // Unix epoch milliseconds at which `position_ms` was accurate.
  position_updated_at_ms?: number | null;
  duration_ms?: number | null;
  playback_rate?: number | null;
  source_app_id?: string | null;
};

// Timeline values exactly as reported by the backend, before local anchoring.
export type RawTimeline = {
  position_ms: number | null;
  position_updated_at_ms: number | null;
};

export type AnchoredSnapshot<T extends TimelineSnapshot> = T & {
  raw_timeline: RawTimeline;
};

// New tracks reporting a position past this fraction are treated as stale carry-over
// from the previous track.
export const STALE_TRACK_POSITION_RATIO = 0.35;

function isSameTrack(a: TimelineSnapshot, b: TimelineSnapshot): boolean {
  return (
    (a.source_app_id ?? null) === (b.source_app_id ?? null) &&
    a.props.title === b.props.title &&
    a.props.artist === b.props.artist &&
    (a.props.album_title ?? null) === (b.props.album_title ?? null)
  );
}

function effectiveRate(snapshot: TimelineSnapshot): number {
  const rate = snapshot.playback_rate;
  return rate != null && Number.isFinite(rate) && rate > 0 ? rate : 1;
}

/**
 * Computes the playback position at `nowMs`, extrapolating from the snapshot's
 * anchor when media is playing. Returns null when no position is known.
 */
export function computePlaybackPosition(
  snapshot: TimelineSnapshot | null | undefined,
  nowMs: number
): number | null {
  if (!snapshot || snapshot.position_ms == null) return null;

  let position = snapshot.position_ms;
  if (snapshot.is_playing && snapshot.position_updated_at_ms != null) {
    const elapsed = Math.max(0, nowMs - snapshot.position_updated_at_ms);
    position += elapsed * effectiveRate(snapshot);
  }

  const duration = snapshot.duration_ms;
  const max = duration != null && duration > 0 ? duration : Infinity;
  return Math.min(max, Math.max(0, position));
}

/**
 * Turns a backend snapshot into one whose `position_ms`/`position_updated_at_ms`
 * pair is a reliable wall-clock anchor for local progress extrapolation.
 */
export function anchorSnapshot<T extends TimelineSnapshot>(
  incoming: T,
  previous: AnchoredSnapshot<TimelineSnapshot> | null | undefined,
  nowMs: number
): AnchoredSnapshot<T> {
  const raw: RawTimeline = {
    position_ms: incoming.position_ms ?? null,
    position_updated_at_ms: incoming.position_updated_at_ms ?? null,
  };

  const sameTrack = !!previous && isSameTrack(previous, incoming);

  // Backend repeated the same timeline (e.g. refresh, metadata/art update, or a player
  // that does not refresh its timeline on play/pause). Continue from our local estimate
  // instead of re-anchoring a possibly stale position to "now".
  if (
    previous &&
    sameTrack &&
    previous.raw_timeline.position_ms === raw.position_ms &&
    previous.raw_timeline.position_updated_at_ms === raw.position_updated_at_ms
  ) {
    const positionMs = computePlaybackPosition(previous, nowMs);
    return {
      ...incoming,
      position_ms: positionMs,
      position_updated_at_ms: positionMs == null ? null : nowMs,
      raw_timeline: raw,
    };
  }

  let anchored: AnchoredSnapshot<T> = {
    ...incoming,
    position_ms: raw.position_ms,
    // Without a backend timestamp the position is assumed to be fresh; never trust a
    // timestamp from the future (clock skew), as it would make progress stall.
    position_updated_at_ms:
      raw.position_ms == null
        ? null
        : Math.min(nowMs, raw.position_updated_at_ms ?? nowMs),
    raw_timeline: raw,
  };

  // Some players briefly report the previous track's timeline after a natural track
  // transition. Prevent a temporary jump towards 100%.
  const trackChanged =
    !!previous &&
    !sameTrack &&
    (previous.source_app_id ?? null) === (incoming.source_app_id ?? null);
  const duration = incoming.duration_ms;
  if (trackChanged && incoming.is_playing && duration != null && duration > 0) {
    const position = computePlaybackPosition(anchored, nowMs) ?? 0;
    if (position > 0 && position / duration > STALE_TRACK_POSITION_RATIO) {
      anchored = { ...anchored, position_ms: 0, position_updated_at_ms: nowMs };
    }
  }

  return anchored;
}
