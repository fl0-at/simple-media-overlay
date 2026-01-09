'use client';

import Image from 'next/image';
import { useState } from 'react';

interface StyledImageProps {
  src: string;
  alt: string;
  className: string;
  width: number;
  height: number;
  pinned: boolean;
  unoptimized?: boolean;
  fadeIn?: boolean;
}

export function StyledImage({
  src,
  alt,
  className,
  width,
  height,
  pinned,
  unoptimized = true,
  fadeIn = false,
}: StyledImageProps) {
  const [isLoaded, setIsLoaded] = useState(!fadeIn); // Start as loaded if no fade-in needed
  
  return (
    <Image
      src={src}
      alt={alt}
      className={`${className} ${fadeIn ? (isLoaded ? 'image-loaded' : 'image-loading') : ''}`}
      draggable={false}
      onDragStart={(e) => {
        if (pinned) e.preventDefault();
      }}
      onLoad={() => {
        if (fadeIn) setIsLoaded(true);
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
