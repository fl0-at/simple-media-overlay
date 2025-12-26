'use client';

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEffect, useState, MouseEvent } from 'react';
import { useMediaInfo } from '@/app/hooks/useMediaInfo';
import Image from 'next/image';

type RepeatMode = 'none' | 'track' | 'list';

type MediaSnapshotDto = {
  props: {
    title: string;
    artist: string;
    album_title?: string | null;
    album_image?: string | null;
  };
  is_playing: boolean;
  position_ms?: number | null;
  duration_ms?: number | null;
  is_shuffle?: boolean | null;
  repeat_mode?: RepeatMode | null;
  source_app_id?: string | null;
};

async function sendControl(action: 'playPause' | 'next' | 'previous') {
  try {
    await invoke('control_media', { action });
    if (action === 'next' || action === 'previous') {
      // Ask backend for an immediate fresh snapshot
      await invoke('refresh_media_snapshot');
    }
  } catch (e) {
    console.error('control_media failed', e);
  }
}

async function sendPlaybackMode(mode: 'shuffle' | 'repeat', value: boolean) {
  try {
    if (mode === 'shuffle') {
      await invoke('set_shuffle', { active: value });
    } else if (mode === 'repeat') {
      await invoke('set_repeat', { mode: value ? 'track' : 'none' });
    }
  } catch (e) {
    console.error('sendPlaybackMode failed', e);
  }
}

async function sendSeek(positionMs: number) {
  try {
    await invoke('seek_to', { positionMs });
  } catch (e) {
    console.error('seek_to failed', e);
  }
}

export default function OverlayPage() {
  const media = useMediaInfo(); // existing gsmtc-based metadata (title/artist/album_image)
  const [snapshot, setSnapshot] = useState<MediaSnapshotDto | null>(null);
  const [playElapsedMs, setPlayElapsedMs] = useState(0);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    listen<MediaSnapshotDto>('media_snapshot', (event) => {
      setSnapshot(event.payload);
    }).then((u) => {
      unlisten = u;
    });

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    // If not playing or no valid duration, stop and reset.
    if (!snapshot?.is_playing || !snapshot?.duration_ms || snapshot.duration_ms <= 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPlayElapsedMs(0);
      return;
    }

    let frameId: number;
    let last = performance.now();

    const tick = (now: number) => {
      const dt = now - last;
      last = now;

      setPlayElapsedMs((prev) => {
        const next = prev + dt;
        return Math.min(next, snapshot.duration_ms!);
      });

      frameId = requestAnimationFrame(tick);
    };

    frameId = requestAnimationFrame(tick);

    // Cleanup: cancel loop and reset elapsed when playback state/duration change
    return () => {
      cancelAnimationFrame(frameId);
      setPlayElapsedMs(0);
    };
  }, [snapshot?.is_playing, snapshot?.duration_ms]);

  if (!media || !media.title) return null;


  const effectiveTitle = snapshot?.props?.title || media.title;
  const effectiveArtist = snapshot?.props?.artist || media.artist;
  const effectiveAlbumTitle = snapshot?.props?.album_title ?? media.album_title ?? null;

  const snapshotImage = snapshot?.props?.album_image
    ? `data:image/png;base64,${snapshot.props.album_image}`
    : null;

  const mediaImage = media.album_image
    ? `data:image/png;base64,${media.album_image}`
    : null;

  const imageSrc = snapshotImage || mediaImage;

  const durationMs = snapshot?.duration_ms ?? null;
  const basePositionMs = snapshot?.position_ms ?? null;

  const isPlaying = snapshot?.is_playing ?? false;
  const isShuffle = snapshot?.is_shuffle ?? false;
  const repeatMode: RepeatMode | null = snapshot?.repeat_mode ?? null;
  const isRepeat = repeatMode === 'track' || repeatMode === 'list';

  let effectivePositionMs = basePositionMs;

  if (
    isPlaying &&
    durationMs &&
    durationMs > 0 &&
    basePositionMs != null
  ) {
    const advanced = basePositionMs + playElapsedMs;
    effectivePositionMs = Math.min(durationMs, advanced);
  }

  const hasTimeline = durationMs && durationMs > 0;

  const progress =
    hasTimeline && effectivePositionMs != null
      ? Math.min(1, Math.max(0, effectivePositionMs / durationMs))
      : 0;

  const handleProgressClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!hasTimeline || !durationMs) return;
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const fraction = Math.min(1, Math.max(0, x / rect.width));
    const targetMs = Math.round(durationMs * fraction);
    sendSeek(targetMs);
  };

  return (
    <div
      className="w-screen h-screen flex items-center flex-start gap-1 flex-row px-2 py-1.5"
      style={{ background: 'rgba(0,0,0,0.75)', WebkitAppRegion: 'drag' } as never}
    >
      <div
        className="flex flex-col items-center justify-center p-1 min-w-25 min-h-25"
        style={{ WebkitAppRegion: 'drag' } as never}
      >
        {imageSrc && (
          <Image
            src={imageSrc}
            alt={media.title}
            className="w-24 h-24 rounded-md object-cover"
            style={{ WebkitAppRegion: 'drag' } as never}
            width={128}
            height={128}
          />
        )}
      </div>
      <div
        className="flex flex-col content-center justify-center w-full"
        style={{ WebKitAppRegion: 'drag' } as never}
      >
        <div
          className="flex items-center gap-0.5 flex-col w-full"
          style={{ WebkitAppRegion: 'drag' } as never}
        >
          <div
            className="text-lg font-semibold text-white w-full"
            style={{ WebkitAppRegion: 'drag' } as never}
          >
            {effectiveTitle}
          </div>
          <div
            className="text-sm text-white/80 w-full"
            style={{ WebkitAppRegion: 'drag' } as never}
          >
            {effectiveArtist}
          </div>
          {media.album_title && (
            <div
              className="text-xs text-white/60 w-full"
              style={{ WebkitAppRegion: 'drag' } as never}
            >
              {effectiveAlbumTitle}
            </div>
          )}
        </div>

        {/* Timeline */}
        {hasTimeline && (
          <div
            className="mt-2 w-full h-1.5 bg-white/15 rounded-full cursor-pointer"
            style={{ WebkitAppRegion: 'no-drag' } as never}
            onClick={handleProgressClick}
          >
            <div
              className="h-full bg-white rounded-full"
              style={{ width: `${progress * 100}%` }}
            />
          </div>
        )}

        <div
          className="flex items-center gap-3 mt-3 justify-center"
          style={{ WebkitAppRegion: 'no-drag' } as never}
        >
          <button
            className={
              'px-2 py-1 rounded-full text-xs ' +
              (isRepeat
                ? 'bg-white text-black font-semibold'
                : 'bg-white/10 hover:bg-white/20 text-white')
            }
            onClick={() => sendPlaybackMode('repeat', !isRepeat)}
            id="repeat-button"
          >
            🔁
          </button>
          <button
            className="px-2 py-1 rounded-full bg-white/10 hover:bg-white/20 text-xs"
            id="back-button"
            onClick={() => sendControl('previous')}
          >
            I◀◀
          </button>
          <button
            className="px-3 py-1 rounded-full bg-white hover:bg-white/80 text-xs text-black font-semibold"
            id="play-pause-button"
            onClick={() => sendControl('playPause')}
          >
            {isPlaying ? ' ⏸ ' : ' ▶ '}
          </button>
          <button
            className="px-2 py-1 rounded-full bg-white/10 hover:bg-white/20 text-xs"
            id="next-button"
            onClick={() => sendControl('next')}
          >
            ▶▶I
          </button>
          <button
            className={
              'px-2 py-1 rounded-full text-xs ' +
              (isShuffle
                ? 'bg-white text-black font-semibold'
                : 'bg-white/10 hover:bg-white/20 text-white')
            }
            onClick={() => sendPlaybackMode('shuffle', !isShuffle)}
            id="shuffle-button"
          >
            🔀
          </button>
        </div>
      </div>
    </div>
  );
}
