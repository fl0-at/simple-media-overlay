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
  onLoad?: () => void;
  onError?: () => void;
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
  onLoad,
  onError,
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
        onLoad?.();
      }}
      onError={onError}
      style={{
        userSelect: 'none',
      } as never}
      width={width}
      height={height}
      unoptimized={unoptimized}
    />
  );
}
