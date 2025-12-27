'use client';

import { isPlaybackModeSupported } from './appInfo';

interface MediaControlsProps {
  isPlaying: boolean;
  isShuffle: boolean;
  isRepeat: boolean;
  sourceAppId: string | null;
  pinned: boolean;
  onPlayPause: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onShuffle: (value: boolean) => void;
  onRepeat: (value: boolean) => void;
}

export function MediaControls({
  isPlaying,
  isShuffle,
  isRepeat,
  sourceAppId,
  pinned,
  onPlayPause,
  onPrevious,
  onNext,
  onShuffle,
  onRepeat,
}: MediaControlsProps) {
  const showPlaybackModes = isPlaybackModeSupported(sourceAppId);

  return (
    <div
      className="flex items-center gap-3 mt-3 justify-center"
      style={{
        WebkitAppRegion: pinned ? 'no-drag' : 'drag',
        userSelect: 'none',
      } as never}
    >
      {showPlaybackModes && (
        <button
          className={
            'px-2 py-1 rounded-full text-xs ' +
            (isRepeat
              ? 'bg-white text-black font-semibold'
              : 'bg-white/10 hover:bg-white/20 text-white')
          }
          onClick={() => onRepeat(!isRepeat)}
          id="repeat-button"
          style={{ WebkitAppRegion: 'no-drag' } as never}
        >
          🔁
        </button>
      )}
      <button
        className="px-2 py-1 rounded-full bg-white/10 hover:bg-white/20 text-xs"
        id="back-button"
        onClick={onPrevious}
        style={{ WebkitAppRegion: 'no-drag' } as never}
      >
        I◀◀
      </button>
      <button
        className="px-3 py-1 rounded-full bg-white hover:bg-white/80 text-xs text-black font-semibold"
        id="play-pause-button"
        onClick={onPlayPause}
        style={{ WebkitAppRegion: 'no-drag' } as never}
      >
        {isPlaying ? ' ⏸ ' : ' ▶ '}
      </button>
      <button
        className="px-2 py-1 rounded-full bg-white/10 hover:bg-white/20 text-xs"
        id="next-button"
        onClick={onNext}
        style={{ WebkitAppRegion: 'no-drag' } as never}
      >
        ▶▶I
      </button>
      {showPlaybackModes && (
        <button
          className={
            'px-2 py-1 rounded-full text-xs ' +
            (isShuffle
              ? 'bg-white text-black font-semibold'
              : 'bg-white/10 hover:bg-white/20 text-white')
          }
          onClick={() => onShuffle(!isShuffle)}
          id="shuffle-button"
          style={{ WebkitAppRegion: 'no-drag' } as never}
        >
          🔀
        </button>
      )}
    </div>
  );
}
