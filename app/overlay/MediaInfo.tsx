'use client';

import { ReactNode } from 'react';

interface MediaInfoProps {
  title: ReactNode;
  artist: ReactNode;
  pinned: boolean;
}

export function MediaInfo({ title, artist, pinned }: MediaInfoProps) {
  const dragRegionProps = pinned ? {} : { 'data-tauri-drag-region': '' };

  return (
    <div
      className="flex min-w-0 flex-1 flex-col justify-center gap-0.5"
      {...dragRegionProps}
    >
      {title}
      {artist}
    </div>
  );
}
