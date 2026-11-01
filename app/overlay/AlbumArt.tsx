'use client';

import { StyledImage } from '../StyledImage';
import { useEffect, useState } from 'react';

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
            <div className="relative w-26 h-26 shrink-0" style={{ aspectRatio: '1/1' }}>
                <AlbumArtImage
                    key={JSON.stringify([imageKey, imageSrc])}
                    imageSrc={imageSrc}
                    albumTitle={albumTitle}
                    pinned={pinned}
                />
            </div>
        </div>
    );
}

function AlbumArtImage({ imageSrc, albumTitle, pinned }: AlbumArtProps) {
    const [status, setStatus] = useState<'loading' | 'loaded' | 'unavailable'>('loading');

    useEffect(() => {
        if (imageSrc) return;

        // Allow for the backend's 1.5-second stale-art check and the next poll.
        const timeout = setTimeout(() => setStatus('unavailable'), 2000);
        return () => clearTimeout(timeout);
    }, [imageSrc]);

    return (
        <>
            {status === 'loading' && (
                <div
                    role="status"
                    aria-label="Loading album art"
                    className="absolute inset-0 rounded-lg bg-white/10 shadow-album-art motion-safe:animate-pulse"
                />
            )}
            {imageSrc && status !== 'unavailable' && (
                <StyledImage
                    src={imageSrc}
                    alt={albumTitle || 'Album Art'}
                    className={`w-full h-full rounded-lg object-cover shadow-album-art ${status === 'loading' ? 'opacity-0' : ''}`}
                    width={104}
                    height={104}
                    pinned={pinned}
                    unoptimized
                    onLoad={() => setStatus('loaded')}
                    onError={() => {
                        console.warn('Failed to load album art', { albumTitle });
                        setStatus('unavailable');
                    }}
                />
            )}
            {status === 'unavailable' && (
                <StyledImage
                    src="/Generic.svg"
                    alt="No Album Art"
                    className="w-full h-full rounded-lg object-cover bg-white/5 shadow-album-art"
                    width={104}
                    height={104}
                    pinned={pinned}
                    unoptimized
                />
            )}
        </>
    );
}
