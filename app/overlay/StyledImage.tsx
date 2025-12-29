'use client';

import Image from 'next/image';

interface StyledImageProps {
  src: string;
  alt: string;
  className: string;
  width: number;
  height: number;
  pinned: boolean;
  unoptimized?: boolean;
}

export function StyledImage({
  src,
  alt,
  className,
  width,
  height,
  pinned,
  unoptimized = true,
}: StyledImageProps) {
  return (
    <Image
      src={src}
      alt={alt}
      className={className}
      draggable={false}
      onDragStart={(e) => {
        if (pinned) e.preventDefault();
      }}
      style={{
        WebkitAppRegion: pinned ? 'no-drag' : 'drag',
        userSelect: 'none',
      } as never}
      width={width}
      height={height}
      unoptimized={unoptimized}
    />
  );
}
