# Simple Media Overlay

## About this project

I wanted to build a simple media overlay app that stays on top, so I vibe-coded one. This app uses [tauri](https://v2.tauri.app/) in the backend (using [win-gsmtc](https://docs.rs/win-gsmtc/latest/gsmtc/) to get media info from Windows) and [NextJS](https://nextjs.org/) as the frontend, and honestly, it turned out better than I thought:

![Simple Media Overlay](./assets/SimpleMediaOverlay.png)

## Features

- 📻 Always-on-top overlay that displays currently playing media
- 📍 Pin the overlay to avoid accidentally moving it, unpin to allow dragging again
- 👀 Little icon in the bottom left corner of the album art, showing the source of the currently playing media
- ⏯️ Play/Pause, Skip to next or previous track or use the seek bar to skip to a certain part of the currently playing media
- ℹ️ Auto-scrolling for longer titles

## Running the overlay

Run this command to launch the overlay in dev mode:

```bash
npx tauri dev
```

If you want to actually build from the source, run this command:

```bash
npx tauri build
```

Alternatively, simply download either the NSIS or MSI installer from the [latest release](https://github.com/fl0-at/simple-media-overlay/releases/latest).

## Supported media playback sources

Any media player or application that publishes metadata about the currently playing media via GSMTC APIs should work out of the box, but these ones were tested and have their own dedicated icons:

- 🌐 Google Chrome
- 🌎 Microsoft Edge
- 🦊 Mozilla Firefox
- 🦁 Brave Browser
- ⭕ Opera Browser
- 🌊 Tidal Desktop Client
- 🚧 Videolan VLC (UWP App only as of now)
- 🐒 MediaMonkey 2024
- 🪟 Windows 11 default media player

For the following apps, I have not tested, but they should have their own icons:

- 🍎 Apple Music
- 🎧 Apple Podcasts
- 🧭 Safari Browser
- ▶️ Groove Media Player
- 🛜 Spotify

_I also added Kodi, but later found out it does not actually publish any media metadata via GSMTC APIs, and I can confirm that the overlay will not display media that is played via Kodi._

**If you want me to add a specific media player/app icon, please [open a new issue](https://github.com/fl0-at/simple-media-overlay/issues/new)!**

## Current Limitations

For some reason, the shuffle and repeat functionality don't seem to work when playing media via the following apps, so I've hidden those buttons for now in those cases, as they wouldn't be functional anyway:

- 🌐 Google Chrome
- 🌎 Microsoft Edge
- 🦊 Mozilla Firefox
- 🦁 Brave Browser
- ⭕ Opera Browser
- 🌊 Tidal Desktop Client
- 🐒 MediaMonkey 2024

_Since this app is currently based around the [win-gsmtc](https://docs.rs/win-gsmtc/latest/gsmtc/) crate, please don't expect me to add support for other OSes - I might switch to another cross-platform crate later_ 🙂
