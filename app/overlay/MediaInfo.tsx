'use client';

import { ReactNode } from 'react';

interface MediaInfoProps {
  title: ReactNode;
  artist: ReactNode;
  pinned: boolean;
}

export function MediaInfo({ title, artist, pinned }: MediaInfoProps) {
  return (
    <div
      className="flex items-center gap-0.5 flex-col w-9/13 min-w-9/13 h-12"
      style={{ WebkitAppRegion: pinned ? 'no-drag' : 'drag' } as never}
    >
      {title}
      {artist}
    </div>
  );
}
