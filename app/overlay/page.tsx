'use client';

import { invoke } from '@tauri-apps/api/core';
import { useMediaInfo } from '@/app/hooks/useMediaInfo';
import Image from 'next/image';

async function sendControl(action: 'playPause' | 'next' | 'previous') {
  try {
    await invoke('control_media', { action });
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

export default function OverlayPage() {
  const media = useMediaInfo();
  if (!media || !media.title) return null;

  const imageSrc = media.album_image
    ? `data:image/png;base64,${media.album_image}`
    : null;

  return (
    <div
      className="w-screen h-screen flex items-center flex-start gap-1 flex-row px-2"
      style={{ background: 'rgba(0,0,0,0.75)', WebkitAppRegion: 'drag' } as never}
    >
      <div
        className="flex flex-col items-center justify-center mr-1 px-0 min-w-20 min-h-20"
        style={{ WebkitAppRegion: 'drag' } as never}
      >
        {imageSrc && (
          <Image
            src={imageSrc}
            alt={media.title}
            className="w-20 h-20 rounded-md object-cover"
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

          <div className="text-lg font-semibold text-white w-full" style={{ WebkitAppRegion: 'drag' } as never}>{media.title}</div>
          <div className="text-sm text-white/80 w-full" style={{ WebkitAppRegion: 'drag' } as never}>{media.artist}</div>
          {media.album_title && (
            <div className="text-xs text-white/60 w-full" style={{ WebkitAppRegion: 'drag' } as never}>{media.album_title}</div>
          )}

        </div>

        <div
          className="flex items-center gap-3 mt-3 justify-center"
          style={{ WebkitAppRegion: 'drag' } as never}
        >
          <button
            className="px-2 py-1 rounded-full bg-white/10 hover:bg-white/20 text-xs"
            onClick={() => sendPlaybackMode('repeat', true)}
          >
            🔁
          </button>
          <button
            className="px-2 py-1 rounded-full bg-white/10 hover:bg-white/20 text-xs"
            onClick={() => sendControl('previous')}
          >
            ◀◀
          </button>
          <button
            className="px-3 py-1 rounded-full bg-white hover:bg-white/80 text-xs text-black font-semibold"
            onClick={() => sendControl('playPause')}
          >
            ⏯
          </button>
          <button
            className="px-2 py-1 rounded-full bg-white/10 hover:bg-white/20 text-xs"
            onClick={() => sendControl('next')}
          >
            ▶▶
          </button>
          <button
            className="px-2 py-1 rounded-full bg-white/10 hover:bg-white/20 text-xs"
            onClick={() => sendPlaybackMode('shuffle', true)}
          >
            🔀
          </button>
        </div>
      </div>
    </div>
  );
}

