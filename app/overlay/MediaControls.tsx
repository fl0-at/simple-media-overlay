'use client';

import { isPlaybackModeSupported } from './appInfo';

type RepeatMode = 'none' | 'track' | 'list';

interface MediaControlsProps {
  isPlaying: boolean;
  isShuffle: boolean;
  repeatMode: RepeatMode;
  sourceAppId: string | null;
  pinned: boolean;
  playPauseImpact?: boolean;
  onPlayPause: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onShuffle: (value: boolean) => void;
  onRepeat: (mode: RepeatMode) => void;
}

export function MediaControls({
  isPlaying,
  isShuffle,
  repeatMode,
  sourceAppId,
  pinned,
  playPauseImpact = false,
  onPlayPause,
  onPrevious,
  onNext,
  onShuffle,
  onRepeat,
}: MediaControlsProps) {
  const showPlaybackModes = isPlaybackModeSupported(sourceAppId);

  const handleRepeatClick = () => {
    // Cycle: none -> list -> track -> none
    if (repeatMode === 'none') {
      onRepeat('list');
    } else if (repeatMode === 'list') {
      onRepeat('track');
    } else {
      onRepeat('none');
    }
  };

  const getRepeatIcon = () => {
    if (repeatMode === 'track') {
      return '🔂'; // repeat one
    } else if (repeatMode === 'list') {
      return '🔁'; // repeat all
    } else {
      return '🔁'; // repeat off (same icon but different style)
    }
  };

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
            (repeatMode !== 'none'
              ? 'bg-white text-black font-semibold'
              : 'bg-white/10 hover:bg-white/20 text-white')
          }
          onClick={handleRepeatClick}
          id="repeat-button"
          style={{ WebkitAppRegion: 'no-drag' } as never}
        >
          {getRepeatIcon()}
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
        className={`px-3 py-1 rounded-full bg-white hover:bg-white/80 text-xs text-black font-semibold min-w-10 ${playPauseImpact ? 'impact-animation' : ''}`}
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
