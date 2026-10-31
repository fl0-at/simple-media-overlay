'use client';

import { StyledImage } from '../StyledImage';

interface AlbumArtProps {
    imageSrc: string | null;
    albumTitle: string | null;
    pinned: boolean;
    imageKey?: string;
}

export function AlbumArt({ imageSrc, albumTitle, pinned, imageKey }: AlbumArtProps) {
    const dragRegionProps = pinned ? {} : { 'data-tauri-drag-region': '' };

    return (
        <div
            className="flex flex-col items-center justify-center p-1"
            {...dragRegionProps}
        >
            <div className="w-26 h-26 shrink-0" style={{ aspectRatio: '1/1' }}>
                {imageSrc ? (
                    <StyledImage
                        key={imageKey}
                        src={imageSrc}
                        alt={albumTitle || 'Album Art'}
                        className="w-full h-full rounded-lg object-cover shadow-album-art"
                        width={104}
                        height={104}
                        pinned={pinned}
                        unoptimized
                    />
                ) : (
                    <StyledImage
                        key={imageKey}
                        src={'/Generic.svg'}
                        alt={'No Album Art'}
                        className="w-full h-full rounded-lg object-cover bg-white/5 shadow-album-art"
                        width={104}
                        height={104}
                        pinned={pinned}
                        unoptimized
                    />
                )}
            </div>
        </div>
    );
}
