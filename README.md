# Simple Media Overlay

## About this project

I wanted to build a simple media overlay app that stays on top, so I vibe-coded one. This app uses [tauri](https://v2.tauri.app/) in the backend (using [win-gsmtc](https://docs.rs/win-gsmtc/latest/gsmtc/) to get media info from Windows) and [NextJS](https://nextjs.org/) as the frontend, and honestly, it turned out better than I thought:

![Simple Media Overlay](./assets/SimpleMediaOverlay.png)

## Running the overlay

Run this command to launch the overlay in dev mode:

```bash
npx tauri dev
```

If you want to actually build from the source, run this command:

```bash
npx tauri build
```

## Current Limitations

For some reason, the shuffle and repeat functionality don't seem to work when playing media via the following apps, so I've hidden those buttons for now in those cases, as they wouldn't be functional anyway:

- Chrome
- Edge
- Firefox
- Brave
- Opera
- Tidal Desktop Client

Since this app is based around the win-gsmtc crate, please don't expect me to add support for other OSes 🙂
