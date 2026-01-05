'use client';

import { StyledImage } from './StyledImage';

interface AlbumArtProps {
    imageSrc: string | null;
    albumTitle: string | null;
    pinned: boolean;
    imageKey?: string;
}

export function AlbumArt({ imageSrc, albumTitle, pinned, imageKey }: AlbumArtProps) {
    return (
        <div
            className="flex flex-col items-center justify-center p-1"
            style={{ WebkitAppRegion: pinned ? 'no-drag' : 'drag' } as never}
        >
            <div className="w-24 h-24 shrink-0" style={{ aspectRatio: '1/1' }}>
                {imageSrc ? (
                    <StyledImage
                        key={imageKey}
                        src={imageSrc}
                        alt={albumTitle || 'Album Art'}
                        className="w-full h-full rounded-lg object-cover shadow-album-art"
                        width={96}
                        height={96}
                        pinned={pinned}
                        unoptimized
                    />
                ) : (
                    <StyledImage
                        key={imageKey}
                        src={'/Generic.svg'}
                        alt={'No Album Art'}
                        className="w-full h-full rounded-lg object-cover bg-white/5 shadow-album-art"
                        width={96}
                        height={96}
                        pinned={pinned}
                        unoptimized
                    />
                )}
            </div>
        </div>
    );
}
