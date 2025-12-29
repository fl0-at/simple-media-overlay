'use client';

import { StyledImage } from './StyledImage';
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
            className="flex flex-col items-center justify-center p-1"
            style={{ WebkitAppRegion: pinned ? 'no-drag' : 'drag' } as never}
        >
            <div className="w-24 h-24 shrink-0" style={{ aspectRatio: '1/1' }}>
                {imageSrc ? (
                    <StyledImage
                        src={imageSrc}
                        alt={albumTitle || 'Album Art'}
                        className="w-full h-full rounded-md object-cover"
                        width={96}
                        height={96}
                        pinned={pinned}
                        unoptimized
                    />
                ) : (
                    <StyledImage
                        src={'/Generic.svg'}
                        alt={'No Album Art'}
                        className="w-full h-full rounded-md object-cover bg-white/5"
                        width={96}
                        height={96}
                        pinned={pinned}
                        unoptimized
                    />
                )}
            </div>

            <StyledImage
                src={player.imageSrc}
                alt={player.name}
                className="w-9 h-9 fixed bottom-1.5 left-1"
                width={36}
                height={36}
                pinned={pinned}
                unoptimized
            />
        </div>
    );
}
