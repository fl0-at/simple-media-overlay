// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlbumArt } from './AlbumArt';

vi.mock('next/image', () => ({
    default: ({ unoptimized, ...props }: React.ImgHTMLAttributes<HTMLImageElement> & { unoptimized?: boolean }) => {
        void unoptimized;
        // Use a DOM image to dispatch load/error events without Next.js internals.
        // eslint-disable-next-line @next/next/no-img-element
        return <img {...props} alt={props.alt} />;
    },
}));

describe('AlbumArt', () => {
    let container: HTMLDivElement;
    let root: Root;

    function render(imageSrc: string | null, imageKey = 'track-1', pinned = false) {
        act(() => {
            root.render(<AlbumArt imageSrc={imageSrc} albumTitle="Album" pinned={pinned} imageKey={imageKey} />);
        });
    }

    function advance(ms: number) {
        act(() => vi.advanceTimersByTime(ms));
    }

    function image() {
        return container.querySelector('img');
    }

    function skeleton() {
        return container.querySelector('[role="status"]');
    }

    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('waits two seconds before showing the missing-art placeholder', () => {
        render(null);
        expect(skeleton()?.getAttribute('aria-label')).toBe('Loading album art');
        expect(image()).toBeNull();
        advance(1999);
        expect(image()).toBeNull();
        advance(1);
        expect(skeleton()).toBeNull();
        expect(image()?.getAttribute('src')).toBe('/Generic.svg');
    });

    it('keeps the skeleton until delayed artwork has actually loaded', () => {
        render(null);
        advance(1500);
        render('/album.png');
        advance(2000);
        expect(skeleton()).not.toBeNull();
        expect(image()?.classList.contains('opacity-0')).toBe(true);
        act(() => image()?.dispatchEvent(new Event('load')));
        expect(skeleton()).toBeNull();
        expect(image()?.classList.contains('opacity-0')).toBe(false);
        expect(image()?.getAttribute('src')).toBe('/album.png');
    });

    it('resets loading when the track or image changes', () => {
        render('/album.png');
        act(() => image()?.dispatchEvent(new Event('load')));
        render('/album.png', 'track-2');
        expect(skeleton()).not.toBeNull();
        act(() => image()?.dispatchEvent(new Event('load')));
        render('/other-album.png', 'track-2');
        expect(skeleton()).not.toBeNull();
        expect(image()?.classList.contains('opacity-0')).toBe(true);
    });

    it('does not restart the missing-art timeout on unrelated rerenders', () => {
        render(null);
        advance(1500);
        render(null, 'track-1', true);
        advance(500);
        expect(image()?.getAttribute('src')).toBe('/Generic.svg');
    });

    it('cancels the previous track timeout and accepts artwork arriving after the timeout', () => {
        render(null);
        advance(1500);
        render(null, 'track-2');
        advance(500);
        expect(skeleton()).not.toBeNull();
        expect(image()).toBeNull();
        advance(1500);
        expect(image()?.getAttribute('src')).toBe('/Generic.svg');
        render('/late-album.png', 'track-2');
        expect(skeleton()).not.toBeNull();
        act(() => image()?.dispatchEvent(new Event('load')));
        expect(image()?.getAttribute('src')).toBe('/late-album.png');
        expect(skeleton()).toBeNull();
    });

    it('reports image failures and shows the placeholder', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        render('/broken.png');
        act(() => image()?.dispatchEvent(new Event('error')));
        expect(warn).toHaveBeenCalledWith('Failed to load album art', { albumTitle: 'Album' });
        expect(skeleton()).toBeNull();
        expect(image()?.getAttribute('alt')).toBe('No Album Art');
        expect(image()?.getAttribute('src')).toBe('/Generic.svg');
    });
});
