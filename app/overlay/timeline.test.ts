import { describe, expect, it } from 'vitest';
import {
  anchorSnapshot,
  computePlaybackPosition,
  type TimelineSnapshot,
} from './timeline';

const NOW = 1_700_000_000_000;

function snap(overrides: Partial<TimelineSnapshot> = {}): TimelineSnapshot {
  return {
    props: { title: 'Song', artist: 'Artist', album_title: 'Album' },
    is_playing: true,
    position_ms: 0,
    position_updated_at_ms: null,
    duration_ms: 200_000,
    playback_rate: null,
    source_app_id: 'Spotify.exe',
    ...overrides,
  };
}

describe('computePlaybackPosition', () => {
  it('returns null without a position', () => {
    expect(computePlaybackPosition(null, NOW)).toBeNull();
    expect(computePlaybackPosition(snap({ position_ms: null }), NOW)).toBeNull();
  });

  it('extrapolates from the anchor while playing', () => {
    const s = snap({ position_ms: 10_000, position_updated_at_ms: NOW - 5_000 });
    expect(computePlaybackPosition(s, NOW)).toBe(15_000);
  });

  it('does not extrapolate while paused', () => {
    const s = snap({ is_playing: false, position_ms: 10_000, position_updated_at_ms: NOW - 5_000 });
    expect(computePlaybackPosition(s, NOW)).toBe(10_000);
  });

  it('applies the playback rate', () => {
    const s = snap({ position_ms: 0, position_updated_at_ms: NOW - 10_000, playback_rate: 1.5 });
    expect(computePlaybackPosition(s, NOW)).toBe(15_000);
  });

  it('clamps to the duration and never goes backwards past the anchor', () => {
    expect(
      computePlaybackPosition(snap({ position_ms: 190_000, position_updated_at_ms: NOW - 60_000 }), NOW)
    ).toBe(200_000);
    expect(
      computePlaybackPosition(snap({ position_ms: 10_000, position_updated_at_ms: NOW + 5_000 }), NOW)
    ).toBe(10_000);
  });
});

describe('anchorSnapshot', () => {
  it('uses the backend timestamp so a mid-track start is in sync', () => {
    // Player last reported its timeline 90s ago at position 0 (e.g. when the track started).
    const anchored = anchorSnapshot(snap({ position_ms: 0, position_updated_at_ms: NOW - 90_000 }), null, NOW);
    expect(computePlaybackPosition(anchored, NOW)).toBe(90_000);
  });

  it('anchors to receipt time when the backend provides no timestamp', () => {
    const anchored = anchorSnapshot(snap({ position_ms: 42_000 }), null, NOW);
    expect(anchored.position_updated_at_ms).toBe(NOW);
    expect(computePlaybackPosition(anchored, NOW + 1_000)).toBe(43_000);
  });

  it('clamps future backend timestamps to now', () => {
    const anchored = anchorSnapshot(snap({ position_ms: 1_000, position_updated_at_ms: NOW + 10_000 }), null, NOW);
    expect(anchored.position_updated_at_ms).toBe(NOW);
  });

  it('keeps progressing when the backend repeats an unchanged timeline', () => {
    const first = anchorSnapshot(snap({ position_ms: 30_000 }), null, NOW);
    const repeated = anchorSnapshot(snap({ position_ms: 30_000 }), first, NOW + 4_000);
    expect(computePlaybackPosition(repeated, NOW + 4_000)).toBe(34_000);
    expect(repeated.raw_timeline.position_ms).toBe(30_000);
  });

  it('freezes at the extrapolated position when paused without a timeline update', () => {
    const playing = anchorSnapshot(snap({ position_ms: 30_000 }), null, NOW);
    const paused = anchorSnapshot(snap({ position_ms: 30_000, is_playing: false }), playing, NOW + 5_000);
    expect(computePlaybackPosition(paused, NOW + 20_000)).toBe(35_000);

    const resumed = anchorSnapshot(snap({ position_ms: 30_000 }), paused, NOW + 30_000);
    expect(computePlaybackPosition(resumed, NOW + 31_000)).toBe(36_000);
  });

  it('re-anchors when the backend reports a new timeline (e.g. after a seek)', () => {
    const first = anchorSnapshot(snap({ position_ms: 30_000, position_updated_at_ms: NOW }), null, NOW);
    const seeked = anchorSnapshot(
      snap({ position_ms: 120_000, position_updated_at_ms: NOW + 2_000 }),
      first,
      NOW + 2_100
    );
    expect(computePlaybackPosition(seeked, NOW + 2_100)).toBe(120_100);
  });

  it('resets stale carry-over positions on a same-source track change', () => {
    const first = anchorSnapshot(snap({ position_ms: 0, position_updated_at_ms: NOW - 195_000 }), null, NOW);
    // Metadata switched to the next track but the timeline still describes the old one.
    const nextTrack = anchorSnapshot(
      snap({ props: { title: 'Next', artist: 'Artist' }, position_ms: 0, position_updated_at_ms: NOW - 195_000 }),
      first,
      NOW
    );
    expect(computePlaybackPosition(nextTrack, NOW)).toBe(0);

    // A follow-up snapshot with the same stale timeline must not jump back.
    const followUp = anchorSnapshot(
      snap({ props: { title: 'Next', artist: 'Artist' }, position_ms: 0, position_updated_at_ms: NOW - 195_000 }),
      nextTrack,
      NOW + 1_000
    );
    expect(computePlaybackPosition(followUp, NOW + 1_000)).toBe(1_000);
  });

  it('keeps legitimate positions after an app switch', () => {
    const first = anchorSnapshot(snap(), null, NOW);
    const otherApp = anchorSnapshot(
      snap({ source_app_id: 'chrome', props: { title: 'Video', artist: 'Channel' }, position_ms: 150_000 }),
      first,
      NOW
    );
    expect(computePlaybackPosition(otherApp, NOW)).toBe(150_000);
  });
});
