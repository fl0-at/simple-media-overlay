# Simple Media Overlay

## About this project

I wanted to build a simple media overlay app that stays on top, so I vibe-coded one. This app uses [tauri](https://v2.tauri.app/) in the backend and [NextJS](https://nextjs.org/) as the frontend, and honestly, it turned out better than I thought:

![Simple Media Overlay](./assets/SimpleMediaOverlay.png)

I decided to add a second overlay that displays synced lyrics, if available, since I found [LRC Library](https://lrclib.net) and [their repo on GitHub](https://github.com/tranxuanthang/lrclib) - here's how that overlay looks:

![Simple Media Overlay - Lyrics Overlay](./assets/SimpleMediaOverlay_Lyrics.png)

## Features

- 📻 Always-on-top overlay that displays currently playing media
- ℹ️ Auto-scrolling for longer titles & artist names
- 📍 Pin the overlay to avoid accidentally moving it, unpin to allow dragging again
- 👀 Little icon in the bottom left corner of the album art, showing the source of the currently playing media
- ⏯️ Play/Pause, Skip to next or previous track or use the seek bar to skip to a certain part of the currently playing media
- 🔁 Toggle repeat mode and/or shuffle, [if supported by the player](#current-limitations)
- 🎼 Toggle the _Lyrics Overlay_ to see synced lyrics, if available on [LRC Library](https://lrclib.net)
- ✨ Fancy animations when the currently played media or the playback source changes, is played/paused or the overlay is pinned
- 🔃 Automatic app-updates to ensure you are running the latest version

## Prerequisites

- **Windows 10 or Windows 11** for the Windows backend via GSMTC
- **A Linux desktop session with D-Bus and an MPRIS-compatible media player** for the Linux backend

### Additional requirements for developers

If you want to build from source or contribute to development:

- **[Node.js](https://nodejs.org/)** (v18 or higher recommended)
- **[Rust](https://www.rust-lang.org/tools/install)** and [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

## Running the overlay

### For end users

Download the installer for your platform from the [latest release](https://github.com/fl0-at/simple-media-overlay/releases/latest):

- **Windows**: MSI installer
- **Linux**: AppImage

The app includes automatic updates - you'll be notified when a new version is available, and the app will automatically update and restart!

### For developers

1. **Install dependencies:**

   ```bash
   npm install
   ```

2. **Run in development mode:**

   ```bash
   npx tauri dev
   ```

3. **Build from source:**

   ```bash
   npx tauri build
   ```

Make sure you have [Rust](https://www.rust-lang.org/tools/install) and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) installed before building.

## Supported media playback sources

On Windows, any media player or application that publishes metadata about the currently playing media via GSMTC APIs should work out of the box, but these ones were tested and have their own dedicated icons:

- 🌐 Google Chrome
- 🌎 Microsoft Edge
- 🦊 Mozilla Firefox
- 🦁 Brave Browser
- ⭕ Opera Browser
- 🎻 Vivaldi Browser
- 🌊 Tidal Desktop Client
- 🛜 Spotify Desktop Client
- 🚧 Videolan VLC (UWP App only as of now)
- 👽 Foobar2000
- 🐒 MediaMonkey 2024
- 🪟 Windows 11 default media player

For the following apps, I have not tested, but they should have their own icons:

- 🍎 Apple Music
- 🎧 Apple Podcasts
- 🎵 iTunes
- 🧭 Safari Browser
- ▶️ Groove Media Player
- ⚡ Winamp

_I also added Kodi, KMPlayer, and Media Player Classic (MPC-HC [as maintained by clsid2](https://github.com/clsid2/mpc-hc)) but later found out they do not actually publish any media metadata via GSMTC APIs, and I can confirm that the overlay will not display media that is played via these apps on Windows._

On Linux, the overlay uses MPRIS. Any player that exposes standard MPRIS metadata and playback controls on the session bus should be discoverable. Artwork, shuffle, repeat, and seek support still depend on what the individual player exports.

**If you want me to add a specific media player/app icon, please [open a new issue](https://github.com/fl0-at/simple-media-overlay/issues/new)!**

## Current Limitations

For some reason, the shuffle and repeat functionality don't seem to work when playing media via the following apps, so I've hidden those buttons for now in those cases, as they wouldn't be functional anyway:

- 🌐 Google Chrome
- 🌎 Microsoft Edge
- 🦊 Mozilla Firefox
- 🦁 Brave Browser
- ⭕ Opera Browser
- 🎻 Vivaldi Browser
- 🧭 Safari Browser
- 🌊 Tidal Desktop Client
- 🐒 MediaMonkey 2024
- 👽 Foobar2000

The following apps also do not publish timeline information via GSMTC APIs on Windows:

- 🐒 MediaMonkey 2024
- 👽 Foobar2000

Thumbnails are not provided via GSMTC APIs by these applications on Windows:

- 🐒 MediaMonkey 2024

### Platform backends

The app now uses platform-specific media backends behind the same Tauri command surface:

- Windows uses GSMTC to read the current system media session and send playback controls.
- Linux uses MPRIS over D-Bus to discover the active player, read metadata, and send playback controls.

### Linux window behavior

On GNOME Wayland sessions, the compositor may ignore the always-on-top hint for undecorated overlay windows even when `alwaysOnTop` is enabled in the Tauri config. This means the overlay and lyrics window may not reliably stay above other windows on distributions such as Zorin OS.

If that happens, you can still enable it manually through the desktop environment: press `Super` + right-click anywhere on the overlay window and turn on the window manager's always-on-top option.

## Troubleshooting

**Ugly-looking "title-bar" in the overlay and lyrics window?**

- This was actually a [known issue](https://github.com/fl0-at/simple-media-overlay/issues/7) that was connected to a [regression recently introduced by Microsoft on the WebView2 runtime](https://github.com/MicrosoftEdge/WebView2Feedback/issues/5492). If you are still experiencing this, make sure to update the WebView2 runtime on your system to at least version 144.0.3719.93 (this should happen automatically via Windows Updates).

**Timeline shows incorrect progress?**

- This is currently a [known issue](https://github.com/fl0-at/simple-media-overlay/issues/4) that I am working on, so feel free to contribute if you spot the root cause of this problem

**Media not showing up?**

- On Windows, make sure your media player publishes to GSMTC (most modern apps do - see [list of supported players here](#current-limitations))
- On Linux, make sure your media player exposes an MPRIS service on the session D-Bus

**Overlay not staying on top?**

- Some fullscreen apps may override the always-on-top behavior
- If you are on a Linux distribution using GNOME and Wayland (like ZorinOS), [this is a limiation I cannot change](#linux-window-behavior)

**Can't move the overlay?**

- Click the pin button to unpin it first

For other issues, please [open an issue](https://github.com/fl0-at/simple-media-overlay/issues/new) on GitHub.

## Contributing

Contributions are welcome! If you'd like to add support for a new media player icon or fix a bug:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Test thoroughly
5. Submit a pull request

**For media player icon requests, please [open an issue](https://github.com/fl0-at/simple-media-overlay/issues/new) first.**

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

**Note on Third-Party Icons:** This software includes icons and logos of third-party media players solely for the purpose of identifying the source of currently playing media. All trademarks, logos, and brand names are the property of their respective owners. The use of these marks does not imply endorsement and does not grant any rights to use these trademarks outside the context of this software. See the [LICENSE](LICENSE) file for complete trademark notices.
