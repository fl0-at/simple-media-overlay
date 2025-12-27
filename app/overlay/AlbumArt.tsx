'use client';

import Image from 'next/image';
import { getPlayerInfo } from './appInfo';

interface AlbumArtProps {
    imageSrc: string | null;
    albumTitle: string | null;
    pinned: boolean;
    sourceAppId?: string | null;
}

export function AlbumArt({ imageSrc, albumTitle, pinned, sourceAppId }: AlbumArtProps) {
    const player = getPlayerInfo(sourceAppId ?? null);

    return (
        <div
            className="flex flex-col items-center justify-center p-1 min-w-25 min-h-25"
            style={{ WebkitAppRegion: pinned ? 'no-drag' : 'drag' } as never}
        >
            {imageSrc ? (
                <Image
                    src={imageSrc}
                    alt={albumTitle || 'Album Art'}
                    className="w-24 h-24 rounded-md object-cover"
                    draggable={false}
                    onDragStart={(e) => {
                        if (pinned) e.preventDefault();
                    }}
                    style={{
                        WebkitAppRegion: pinned ? 'no-drag' : 'drag',
                        userSelect: 'none',
                    } as never}
                    width={128}
                    height={128}
                    unoptimized
                />
            ) : (
                // empty slot when no album art — still render player icon below
                <Image 
                    src={'/Generic.svg'}
                    alt={'No Album Art'}
                    className="w-24 h-24 rounded-md bg-white/5"
                    draggable={false}
                    onDragStart={(e) => {
                        if (pinned) e.preventDefault();
                    }}
                    style={{
                        WebkitAppRegion: pinned ? 'no-drag' : 'drag',
                        userSelect: 'none',
                    } as never}
                    width={128}
                    height={128}
                    unoptimized
                />
            )}

            <Image
                src={player.imageSrc}
                alt={player.name}
                className="w-9 h-9 fixed bottom-1.5 left-1"
                draggable={false}
                onDragStart={(e) => {
                    if (pinned) e.preventDefault();
                }}
                style={{
                    WebkitAppRegion: pinned ? 'no-drag' : 'drag',
                    userSelect: 'none',
                } as never}
                width={24}
                height={24}
                unoptimized
            />
        </div>
    );
}
