# Simple Media Overlay

## About this project

I wanted to build a simple media overlay app, so I vibe-coded one. This app uses [tauri](https://v2.tauri.app/) in the backend (using [win-gsmtc](https://docs.rs/win-gsmtc/latest/gsmtc/) to get media info from Windows) and [NextJS](https://nextjs.org/) as the frontend, and honestly, it turned out better than I thought:

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