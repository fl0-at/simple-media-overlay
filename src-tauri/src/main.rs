#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

#[cfg(target_os = "windows")]
use gsmtc::{ManagerEvent, SessionManager, SessionUpdateEvent};
#[cfg(target_os = "linux")]
use mpris::{LoopStatus, PlaybackStatus, Player, PlayerFinder};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::UpdaterExt;
#[cfg(not(target_os = "windows"))]
use tokio::sync::Mutex;
#[cfg(target_os = "windows")]
use tokio::sync::{mpsc::UnboundedReceiver, Mutex};
use tokio::time::sleep;

#[cfg(target_os = "windows")]
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession, GlobalSystemMediaTransportControlsSessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus,
};
#[cfg(target_os = "windows")]
use windows::Media::MediaPlaybackAutoRepeatMode;

#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{
    CallWindowProcW, DefWindowProcW, DeleteMenu, GetSystemMenu, GetWindowLongPtrW,
    SetWindowLongPtrW, GWLP_WNDPROC, GWL_STYLE, MF_BYCOMMAND, SC_MAXIMIZE, SC_MINIMIZE, SC_RESTORE,
    SC_SIZE, WM_CONTEXTMENU, WM_NCRBUTTONDOWN, WM_NCRBUTTONUP, WM_RBUTTONDOWN, WM_RBUTTONUP,
    WM_SYSCOMMAND, WS_MAXIMIZEBOX, WS_MINIMIZEBOX,
};

#[cfg(target_os = "windows")]
use std::sync::Mutex as StdMutex2;

#[cfg(target_os = "windows")]
lazy_static::lazy_static! {
    static ref OLD_WNDPROCS: StdMutex2<HashMap<isize, isize>> = StdMutex2::new(HashMap::new());
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn custom_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    // Block the context menu and all right-click related messages
    match msg {
        WM_CONTEXTMENU | WM_RBUTTONDOWN | WM_RBUTTONUP | WM_NCRBUTTONDOWN | WM_NCRBUTTONUP => {
            return LRESULT(0);
        }
        WM_SYSCOMMAND => {
            // Block maximize, minimize, restore, and size commands
            let cmd = wparam.0 & 0xFFF0;
            if cmd == SC_MAXIMIZE as usize
                || cmd == SC_MINIMIZE as usize
                || cmd == SC_RESTORE as usize
                || cmd == SC_SIZE as usize
            {
                return LRESULT(0);
            }
        }
        _ => {}
    }

    // Call the original window procedure for this specific HWND
    let old_procs = OLD_WNDPROCS.lock().unwrap();
    if let Some(&old_proc) = old_procs.get(&(hwnd.0 as isize)) {
        drop(old_procs);
        CallWindowProcW(
            Some(std::mem::transmute(old_proc)),
            hwnd,
            msg,
            wparam,
            lparam,
        )
    } else {
        drop(old_procs);
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum RepeatMode {
    None,
    Track,
    List,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LrcLibResponse {
    id: Option<i64>,
    #[serde(rename = "trackName")]
    track_name: Option<String>,
    #[serde(rename = "artistName")]
    artist_name: Option<String>,
    #[serde(rename = "albumName")]
    album_name: Option<String>,
    duration: Option<f64>,
    instrumental: Option<bool>,
    #[serde(rename = "plainLyrics")]
    plain_lyrics: Option<String>,
    #[serde(rename = "syncedLyrics")]
    synced_lyrics: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LyricsResponse {
    plain_lyrics: Option<String>,
    synced_lyrics: Option<String>,
    instrumental: bool,
}

#[cfg(target_os = "linux")]
fn duration_to_i64_ms(duration: Duration) -> Option<i64> {
    i64::try_from(duration.as_millis()).ok()
}

#[cfg(target_os = "linux")]
fn map_repeat_mode_enum(mode: LoopStatus) -> RepeatMode {
    match mode {
        LoopStatus::Track => RepeatMode::Track,
        LoopStatus::Playlist => RepeatMode::List,
        LoopStatus::None => RepeatMode::None,
    }
}

fn normalize_source_app_id(source_app_id: Option<&str>) -> String {
    let Some(source_app_id) = source_app_id else {
        return String::new();
    };

    let lower = source_app_id.to_lowercase();
    let before_bang = lower.split('!').next().unwrap_or_default();
    let before_underscore = before_bang.split('_').next().unwrap_or_default();
    let without_instance = before_underscore
        .split(".instance")
        .next()
        .unwrap_or(before_underscore);
    without_instance
        .strip_suffix(".desktop")
        .unwrap_or(without_instance)
        .to_string()
}

#[cfg(target_os = "linux")]
fn get_player_source_app_id(player: &Player) -> Option<String> {
    let bus_name = player.bus_name_player_name_part();
    let bus_source = if bus_name.is_empty() {
        None
    } else {
        Some(bus_name.to_string())
    };

    bus_source
        .or_else(|| player.get_desktop_entry().ok().flatten())
        .or_else(|| {
            let identity = player.identity();
            if identity.is_empty() {
                None
            } else {
                Some(identity.to_string())
            }
        })
}

#[cfg(target_os = "linux")]
fn get_active_linux_player(
    preferred_source_normalized: Option<&str>,
) -> Result<Option<Player>, String> {
    let finder =
        PlayerFinder::new().map_err(|e| format!("Failed to connect to MPRIS D-Bus: {e:?}"))?;
    let players = finder
        .iter_players()
        .map_err(|e| format!("Failed to enumerate MPRIS players: {e:?}"))?;

    let mut preferred_playing_with_title = None;
    let mut playing_with_title = None;
    let mut preferred_playing_without_title = None;
    let mut playing_without_title = None;
    let mut preferred_paused_with_title = None;
    let mut paused_with_title = None;
    let mut preferred_paused_without_title = None;
    let mut paused_without_title = None;
    let mut preferred_fallback_with_title = None;
    let mut fallback_with_title = None;
    let mut preferred_fallback_without_title = None;
    let mut fallback_without_title = None;

    for player_result in players {
        let player = match player_result {
            Ok(player) => player,
            Err(error) => {
                log::debug!("Skipping invalid MPRIS player during discovery: {:?}", error);
                continue;
            }
        };

        let has_title = player
            .get_metadata()
            .ok()
            .and_then(|metadata| metadata.title().map(|title| !title.is_empty()))
            .unwrap_or(false);

        let player_source_normalized =
            normalize_source_app_id(get_player_source_app_id(&player).as_deref());
        let matches_preferred = preferred_source_normalized
            .map(|preferred| !preferred.is_empty() && preferred == player_source_normalized)
            .unwrap_or(false);

        match player.get_playback_status() {
            Ok(PlaybackStatus::Playing)
                if has_title && matches_preferred && preferred_playing_with_title.is_none() =>
            {
                preferred_playing_with_title = Some(player)
            }
            Ok(PlaybackStatus::Playing) if has_title && playing_with_title.is_none() => {
                playing_with_title = Some(player)
            }
            Ok(PlaybackStatus::Playing)
                if matches_preferred && preferred_playing_without_title.is_none() =>
            {
                preferred_playing_without_title = Some(player)
            }
            Ok(PlaybackStatus::Playing) if playing_without_title.is_none() => {
                playing_without_title = Some(player)
            }
            Ok(PlaybackStatus::Paused)
                if has_title && matches_preferred && preferred_paused_with_title.is_none() =>
            {
                preferred_paused_with_title = Some(player)
            }
            Ok(PlaybackStatus::Paused) if has_title && paused_with_title.is_none() => {
                paused_with_title = Some(player)
            }
            Ok(PlaybackStatus::Paused)
                if matches_preferred && preferred_paused_without_title.is_none() =>
            {
                preferred_paused_without_title = Some(player)
            }
            Ok(PlaybackStatus::Paused) if paused_without_title.is_none() => {
                paused_without_title = Some(player)
            }
            _ if has_title && matches_preferred && preferred_fallback_with_title.is_none() => {
                preferred_fallback_with_title = Some(player)
            }
            _ if has_title && fallback_with_title.is_none() => fallback_with_title = Some(player),
            _ if matches_preferred && preferred_fallback_without_title.is_none() => {
                preferred_fallback_without_title = Some(player)
            }
            _ if fallback_without_title.is_none() => fallback_without_title = Some(player),
            _ => {}
        }
    }

    Ok(
        preferred_playing_with_title
            .or(playing_with_title)
            .or(preferred_playing_without_title)
            .or(playing_without_title)
            .or(preferred_paused_with_title)
            .or(preferred_paused_without_title)
            .or(paused_with_title)
            .or(paused_without_title)
            .or(preferred_fallback_with_title)
            .or(preferred_fallback_without_title)
            .or(fallback_with_title)
            .or(fallback_without_title),
    )
}

#[cfg(target_os = "linux")]
async fn get_preferred_source_normalized(state: &Arc<MediaState>) -> Option<String> {
    let snapshot_guard = state.snapshot.lock().await;
    snapshot_guard
        .as_ref()
        .map(|existing| normalize_source_app_id(existing.source_app_id.as_deref()))
        .filter(|source| !source.is_empty())
}

#[cfg(target_os = "linux")]
fn is_suspicious_source_flip(previous: Option<&MediaSnapshotDto>, incoming: &MediaSnapshotDto) -> bool {
    let Some(previous) = previous else {
        return false;
    };

    let previous_source = normalize_source_app_id(previous.source_app_id.as_deref());
    let incoming_source = normalize_source_app_id(incoming.source_app_id.as_deref());
    let source_changed = !previous_source.is_empty()
        && !incoming_source.is_empty()
        && previous_source != incoming_source;

    // During track transitions, MPRIS can briefly surface a paused player from a
    // different app. Ignore that flip while previous source is still playing.
    source_changed && previous.is_playing && !incoming.is_playing
}

#[cfg(target_os = "linux")]
fn sanitize_suspicious_track_position(
    previous: Option<&MediaSnapshotDto>,
    incoming: &mut MediaSnapshotDto,
) {
    if !incoming.is_playing {
        return;
    }

    let Some(duration_ms) = incoming.duration_ms else {
        return;
    };
    if duration_ms <= 0 {
        return;
    }

    let Some(position_ms) = incoming.position_ms else {
        return;
    };
    if position_ms <= 0 {
        return;
    }

    let Some(previous) = previous else {
        return;
    };

    let previous_source = normalize_source_app_id(previous.source_app_id.as_deref());
    let incoming_source = normalize_source_app_id(incoming.source_app_id.as_deref());
    if previous_source.is_empty() || previous_source != incoming_source {
        return;
    }

    let metadata_changed = previous.props.title != incoming.props.title
        || previous.props.artist != incoming.props.artist
        || previous.props.album_title != incoming.props.album_title;
    if !metadata_changed {
        return;
    }

    // Treat large carry-over positions on same-source track transitions as stale.
    let stale_threshold_ms = duration_ms.saturating_mul(35) / 100;
    if position_ms > stale_threshold_ms {
        incoming.position_ms = Some(0);
    }
}

#[cfg(target_os = "linux")]
fn read_art_url_bytes(art_url: &str) -> Option<Vec<u8>> {
    if art_url.starts_with("file://") {
        let raw_path = art_url.trim_start_matches("file://");
        let normalized = raw_path.strip_prefix("localhost/").unwrap_or(raw_path);
        let decoded = urlencoding::decode(normalized).ok()?;
        return std::fs::read(decoded.as_ref()).ok();
    }

    if art_url.starts_with("http://") || art_url.starts_with("https://") {
        let response = reqwest::blocking::Client::new()
            .get(art_url)
            .timeout(Duration::from_secs(5))
            .send()
            .ok()?;
        let bytes = response.bytes().ok()?;
        return Some(bytes.to_vec());
    }

    std::fs::read(art_url).ok()
}

#[cfg(target_os = "linux")]
fn art_url_to_base64(
    art_url: &str,
    cache: Option<&StdMutex<HashMap<String, String>>>,
) -> Option<String> {
    if let Some(cache_mutex) = cache {
        if let Ok(guard) = cache_mutex.lock() {
            if let Some(cached) = guard.get(art_url).cloned() {
                return Some(cached);
            }
        }
    }

    let encoded = BASE64.encode(read_art_url_bytes(art_url)?);

    if let Some(cache_mutex) = cache {
        if let Ok(mut guard) = cache_mutex.lock() {
            guard.insert(art_url.to_string(), encoded.clone());
        }
    }

    Some(encoded)
}

#[cfg(target_os = "linux")]
fn snapshot_from_player(
    player: &Player,
    cache: Option<&StdMutex<HashMap<String, String>>>,
) -> Result<MediaSnapshotDto, String> {
    let metadata = player
        .get_metadata()
        .map_err(|e| format!("Failed to get MPRIS metadata: {e:?}"))?;

    let title = metadata.title().unwrap_or_default().to_string();
    let artist = metadata
        .artists()
        .map(|artists| artists.join(", "))
        .unwrap_or_default();
    let album_title = metadata.album_name().map(str::to_string);
    let album_image = metadata
        .art_url()
        .and_then(|art_url| art_url_to_base64(art_url, cache));

    let is_playing = matches!(
        player
            .get_playback_status()
            .map_err(|e| format!("Failed to get MPRIS playback status: {e:?}"))?,
        PlaybackStatus::Playing
    );

    let position_ms = player
        .checked_get_position()
        .map_err(|e| format!("Failed to get MPRIS position: {e:?}"))?
        .and_then(duration_to_i64_ms);
    let duration_ms = metadata.length().and_then(duration_to_i64_ms);
    let is_shuffle = player
        .checked_get_shuffle()
        .map_err(|e| format!("Failed to get MPRIS shuffle state: {e:?}"))?;
    let repeat_mode = player
        .checked_get_loop_status()
        .map_err(|e| format!("Failed to get MPRIS loop status: {e:?}"))?
        .map(map_repeat_mode_enum);

    let source_app_id = get_player_source_app_id(player);

    Ok(MediaSnapshotDto {
        props: MediaPropsDto {
            title,
            artist,
            album_title,
            album_image,
        },
        is_playing,
        position_ms,
        duration_ms,
        is_shuffle,
        repeat_mode,
        source_app_id,
    })
}

#[cfg(target_os = "linux")]
fn refresh_linux_snapshot_sync(
    cache: Option<&StdMutex<HashMap<String, String>>>,
    preferred_source_normalized: Option<&str>,
) -> Result<Option<MediaSnapshotDto>, String> {
    let Some(player) = get_active_linux_player(preferred_source_normalized)? else {
        return Ok(None);
    };

    snapshot_from_player(&player, cache).map(Some)
}

#[cfg(target_os = "windows")]
fn with_current_session<F>(f: F) -> Result<(), String>
where
    F: FnOnce(GlobalSystemMediaTransportControlsSession) -> Result<(), String>,
{
    let op = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
        .map_err(|e| format!("RequestAsync failed: {e:?}"))?;
    let mgr = op
        .get()
        .map_err(|e| format!("RequestAsync get failed: {e:?}"))?;

    let session = match mgr.GetCurrentSession() {
        Ok(s) => s,
        Err(e) => {
            // Some Windows APIs (via the `windows` crate) can return an Err
            // whose HRESULT is 0 (S_OK) — treat that as non-fatal/no-session
            // (this matches the polling loop behavior which ignores S_OK "noise").
            if e.code().0 == 0 {
                log::debug!("GetCurrentSession returned spurious S_OK Err: {:?}", e);
                return Ok(());
            } else {
                return Err(format!("GetCurrentSession failed: {e:?}"));
            }
        }
    };

    f(session)
}

#[cfg(target_os = "windows")]
fn set_shuffle_sync(active: bool) -> Result<(), String> {
    with_current_session(|session| {
        let op = session
            .TryChangeShuffleActiveAsync(active)
            .map_err(|e| format!("TryChangeShuffleActiveAsync failed: {e:?}"))?;
        let _ = op.get().map_err(|e| format!("Shuffle get failed: {e:?}"))?;
        Ok(())
    })
}

#[cfg(target_os = "linux")]
fn set_shuffle_sync(active: bool, preferred_source_normalized: Option<&str>) -> Result<(), String> {
    let Some(player) = get_active_linux_player(preferred_source_normalized)? else {
        return Ok(());
    };

    let _ = player
        .checked_set_shuffle(active)
        .map_err(|e| format!("Failed to set MPRIS shuffle state: {e:?}"))?;

    Ok(())
}

#[cfg(target_os = "windows")]
fn set_repeat_sync(mode: RepeatMode) -> Result<(), String> {
    with_current_session(|session| {
        let repeat = match mode {
            RepeatMode::None => MediaPlaybackAutoRepeatMode::None,
            RepeatMode::Track => MediaPlaybackAutoRepeatMode::Track,
            RepeatMode::List => MediaPlaybackAutoRepeatMode::List,
        };
        let op = session
            .TryChangeAutoRepeatModeAsync(repeat)
            .map_err(|e| format!("TryChangeAutoRepeatModeAsync failed: {e:?}"))?;
        let _ = op.get().map_err(|e| format!("Repeat get failed: {e:?}"))?;
        Ok(())
    })
}

#[cfg(target_os = "linux")]
fn set_repeat_sync(
    mode: RepeatMode,
    preferred_source_normalized: Option<&str>,
) -> Result<(), String> {
    let Some(player) = get_active_linux_player(preferred_source_normalized)? else {
        return Ok(());
    };

    let repeat = match mode {
        RepeatMode::None => LoopStatus::None,
        RepeatMode::Track => LoopStatus::Track,
        RepeatMode::List => LoopStatus::Playlist,
    };

    let _ = player
        .checked_set_loop_status(repeat)
        .map_err(|e| format!("Failed to set MPRIS loop status: {e:?}"))?;

    Ok(())
}

#[tauri::command]
#[cfg(target_os = "windows")]
async fn set_shuffle(active: bool) -> Result<(), String> {
    set_shuffle_sync(active)
}

#[tauri::command]
#[cfg(target_os = "linux")]
async fn set_shuffle(
    active: bool,
    state: State<'_, Arc<MediaState>>,
) -> Result<(), String> {
    let preferred_source = get_preferred_source_normalized(state.inner()).await;
    set_shuffle_sync(active, preferred_source.as_deref())
}

#[tauri::command]
#[cfg(target_os = "windows")]
async fn set_repeat(mode: RepeatMode) -> Result<(), String> {
    set_repeat_sync(mode)
}

#[tauri::command]
#[cfg(target_os = "linux")]
async fn set_repeat(
    mode: RepeatMode,
    state: State<'_, Arc<MediaState>>,
) -> Result<(), String> {
    let preferred_source = get_preferred_source_normalized(state.inner()).await;
    set_repeat_sync(mode, preferred_source.as_deref())
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn configure_window_menu(window: tauri::Window) -> Result<(), String> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    if let Ok(handle) = window.window_handle() {
        if let RawWindowHandle::Win32(win_handle) = handle.as_raw() {
            unsafe {
                let hwnd = HWND(win_handle.hwnd.get() as _);

                // Check if this window is already configured to avoid double-subclassing
                {
                    let old_procs = OLD_WNDPROCS.lock().unwrap();
                    if old_procs.contains_key(&(hwnd.0 as isize)) {
                        log::debug!("Window '{}' already configured, skipping", window.label());
                        return Ok(());
                    }
                }

                // Remove maximize and minimize from window style
                let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
                let new_style = style & !(WS_MAXIMIZEBOX.0 as isize) & !(WS_MINIMIZEBOX.0 as isize);
                SetWindowLongPtrW(hwnd, GWL_STYLE, new_style);

                // Remove items from system menu
                let hmenu = GetSystemMenu(hwnd, false);
                if !hmenu.is_invalid() {
                    DeleteMenu(hmenu, SC_MAXIMIZE, MF_BYCOMMAND).ok();
                    DeleteMenu(hmenu, SC_MINIMIZE, MF_BYCOMMAND).ok();
                    DeleteMenu(hmenu, SC_RESTORE, MF_BYCOMMAND).ok();
                    DeleteMenu(hmenu, SC_SIZE, MF_BYCOMMAND).ok();
                }

                // Subclass the window to intercept WM_CONTEXTMENU
                let old_proc =
                    SetWindowLongPtrW(hwnd, GWLP_WNDPROC, custom_wndproc as *const () as isize);
                let mut old_procs = OLD_WNDPROCS.lock().unwrap();
                old_procs.insert(hwnd.0 as isize, old_proc);
                drop(old_procs);

                log::info!("Window '{}' configured - HWND: {:?}", window.label(), hwnd);
            }
        }
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
async fn configure_window_menu(_window: tauri::Window) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
async fn fetch_lyrics(
    app: tauri::AppHandle,
    track_name: String,
    artist_name: String,
    album_name: Option<String>,
    duration_ms: Option<i64>,
    state: State<'_, Arc<MediaState>>,
) -> Result<LyricsResponse, String> {
    // Create cache key from artist and track name
    let cache_key = format!(
        "{}|{}",
        artist_name.to_lowercase(),
        track_name.to_lowercase()
    );

    // Check cache first
    {
        let cache = state.lyrics_cache.lock().unwrap();
        if let Some(cached_lyrics) = cache.get(&cache_key) {
            return Ok(cached_lyrics.clone());
        }
    }

    // Build LRCLIB API URL
    let base_url = "https://lrclib.net/api/get";
    let mut url = format!(
        "{}?track_name={}&artist_name={}",
        base_url,
        urlencoding::encode(&track_name),
        urlencoding::encode(&artist_name)
    );

    if let Some(album) = album_name {
        if !album.is_empty() {
            url.push_str(&format!("&album_name={}", urlencoding::encode(&album)));
        }
    }

    if let Some(duration) = duration_ms {
        // Convert ms to seconds
        let duration_sec = (duration as f64 / 1000.0).round() as i64;
        url.push_str(&format!("&duration={}", duration_sec));
    }

    // Determine app version for User-Agent
    let version = app.package_info().version.to_string();

    // Debug log the request
    #[cfg(debug_assertions)]
    {
        log::debug!("fetch_lyrics: GET {} with User-Agent: simple-media-overlay v{} (https://github.com/fl0-at/simple-media-overlay)", url, version);
    }

    // Create HTTP client
    let client = reqwest::Client::new();

    // Make the HTTP request
    let response = client
        .get(&url)
        .header(
            "User-Agent",
            format!(
                "simple-media-overlay v{} (https://github.com/fl0-at/simple-media-overlay)",
                version
            ),
        )
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "Request timed out. Please check your internet connection.".to_string()
            } else if e.is_connect() {
                "Cannot connect to lyrics service. Please check your internet connection."
                    .to_string()
            } else {
                format!("Network error: {}", e)
            }
        })?;

    let status = response.status();

    if status.is_success() {
        let lrclib_data: LrcLibResponse = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse lyrics response: {}", e))?;

        let lyrics_response = LyricsResponse {
            plain_lyrics: lrclib_data.plain_lyrics,
            synced_lyrics: lrclib_data.synced_lyrics,
            instrumental: lrclib_data.instrumental.unwrap_or(false),
        };

        // Cache the result
        {
            let mut cache = state.lyrics_cache.lock().unwrap();
            cache.insert(cache_key, lyrics_response.clone());
        }

        Ok(lyrics_response)
    } else if status.as_u16() == 404 {
        // No lyrics found - don't cache 404s to allow retrying if lyrics are added later
        Err("No lyrics found".to_string())
    } else if status.as_u16() == 429 {
        // Rate limited - don't cache this
        Err("Rate limit exceeded. Please try again later.".to_string())
    } else if status.is_client_error() {
        // 4xx errors (except 404 and 429)
        Err(format!(
            "Invalid request (HTTP {} \"{}\"). Please try a different song.",
            status.as_u16(),
            response.text().await.unwrap_or_default()
        ))
    } else if status.is_server_error() {
        // 5xx errors - server issues
        Err(format!(
            "Lyrics service temporarily unavailable ({}). Please try again later.",
            status.as_u16()
        ))
    } else {
        // Unexpected status
        Err(format!(
            "Unexpected response from lyrics service: {}",
            status
        ))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
struct MediaPropsDto {
    title: String,
    artist: String,
    album_title: Option<String>,
    album_image: Option<String>, // base64 PNG/JPEG
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
struct MediaSnapshotDto {
    props: MediaPropsDto,
    is_playing: bool,
    position_ms: Option<i64>,
    duration_ms: Option<i64>,
    is_shuffle: Option<bool>,
    repeat_mode: Option<RepeatMode>,
    source_app_id: Option<String>,
}

#[derive(Debug, Default)]
struct MediaState {
    props: Mutex<Option<MediaPropsDto>>,
    // last full snapshot from GSMTC (for polling)
    snapshot: Mutex<Option<MediaSnapshotDto>>,
    // Cache of base64-encoded thumbnails keyed by (source_app_id|title|album_title)
    thumbnail_cache: StdMutex<HashMap<String, String>>,
    // Track the last title we successfully cached a thumbnail for (to detect stale fetches)
    #[cfg(target_os = "windows")]
    last_cached_title: Mutex<Option<String>>,
    // Cache of lyrics keyed by (artist|title)
    lyrics_cache: StdMutex<HashMap<String, LyricsResponse>>,
    // Prevent duplicate listener loops when frontend re-invokes start_media_listener.
    listener_started: AtomicBool,
}

#[tauri::command]
async fn get_current_media(
    state: State<'_, Arc<MediaState>>,
) -> Result<Option<MediaPropsDto>, String> {
    Ok(state.props.lock().await.clone())
}

// --- GSMTC snapshot/polling helpers ---------------------------------------

#[cfg(target_os = "windows")]
fn map_repeat_mode_enum(mode: MediaPlaybackAutoRepeatMode) -> RepeatMode {
    match mode {
        MediaPlaybackAutoRepeatMode::Track => RepeatMode::Track,
        MediaPlaybackAutoRepeatMode::List => RepeatMode::List,
        _ => RepeatMode::None,
    }
}

// Build a full snapshot from a GSMTC session (polling path).
#[cfg(target_os = "windows")]
fn snapshot_from_session(
    session: &GlobalSystemMediaTransportControlsSession,
    cache: Option<&StdMutex<HashMap<String, String>>>,
    previous_thumbnail: Option<&String>,
    previous_title: Option<&str>,
) -> Result<MediaSnapshotDto, String> {
    // Media properties (async -> get)
    let media_props_op = session
        .TryGetMediaPropertiesAsync()
        .map_err(|e| format!("TryGetMediaPropertiesAsync failed: {e:?}"))?;
    let media_props = media_props_op
        .get()
        .map_err(|e| format!("TryGetMediaPropertiesAsync get failed: {e:?}"))?;

    // Playback info
    let playback_info = session
        .GetPlaybackInfo()
        .map_err(|e| format!("GetPlaybackInfo failed: {e:?}"))?;

    let status = playback_info
        .PlaybackStatus()
        .map_err(|e| format!("PlaybackStatus failed: {e:?}"))?;

    // Timeline
    let timeline = session
        .GetTimelineProperties()
        .map_err(|e| format!("GetTimelineProperties failed: {e:?}"))?;

    // optional values; if they fail, treat as None
    let title = media_props
        .Title()
        .ok()
        .map(|s| s.to_string())
        .unwrap_or_default();

    let artist = media_props
        .Artist()
        .ok()
        .map(|s| s.to_string())
        .unwrap_or_default();

    let album_title = media_props.AlbumTitle().ok().map(|s| s.to_string());

    let position_ms = timeline.Position().ok().map(|t| t.Duration / 10_000); // 100 ns -> ms
    let duration_ms = timeline.EndTime().ok().map(|t| t.Duration / 10_000);

    let is_playing = matches!(
        status,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing
    );

    let is_shuffle = playback_info
        .IsShuffleActive()
        .ok()
        .and_then(|r| r.Value().ok());
    let repeat_mode = playback_info
        .AutoRepeatMode()
        .ok()
        .and_then(|r| r.Value().ok())
        .map(map_repeat_mode_enum);

    let source_app_id = session.SourceAppUserModelId().ok().map(|s| s.to_string());

    // Build cache key - prioritize album title, but fall back to track title for apps like TIDAL
    // that don't provide album info (empty string or None)
    let use_album_for_cache = album_title.as_ref().map(|a| !a.is_empty()).unwrap_or(false);

    let cache_key = if use_album_for_cache {
        // Use album title for caching (all tracks on same album share art)
        format!(
            "{}\x1F{}",
            source_app_id.as_deref().unwrap_or(""),
            album_title.as_deref().unwrap()
        )
    } else {
        // Use track title for caching (each track has its own art)
        format!("{}\x1F{}", source_app_id.as_deref().unwrap_or(""), title)
    };

    let album_image = if let Some(cache_mutex) = cache {
        let mut guard = cache_mutex
            .lock()
            .map_err(|_| "thumbnail_cache lock poisoned")?;
        if let Some(cached) = guard.get(&cache_key).cloned() {
            // Even with a cache hit, verify freshness when track changes
            // Windows GSMTC might still be returning stale data, so we need to check
            let track_changed = previous_title.map(|prev| prev != title).unwrap_or(false);

            if track_changed {
                // Fetch what Windows is currently providing
                let windows_thumb = thumbnail_to_base64(&media_props);

                // Compare Windows data to cached data
                if let Some(ref win_thumb) = windows_thumb {
                    if win_thumb == &cached {
                        // Windows data matches cache - cache is still fresh, use it
                        Some(cached)
                    } else {
                        // Windows is providing different data
                        // Check if Windows is providing stale data (matches previous track)
                        let windows_is_stale = if let Some(prev_thumb) = previous_thumbnail {
                            win_thumb == prev_thumb
                        } else {
                            false
                        };

                        if windows_is_stale {
                            log::warn!("Windows providing stale thumbnail for '{}' (matches previous track, len: {}). Using cached version and will recheck next poll.", 
                                title, win_thumb.len());
                            // Windows is stale, trust the cache
                            Some(cached)
                        } else {
                            // Windows has fresh, different data - update cache and use it
                            log::warn!("Windows providing different thumbnail for '{}' than cached (win: {}, cached: {}). Updating cache with Windows version.", 
                                title, win_thumb.len(), cached.len());
                            guard.insert(cache_key.clone(), win_thumb.clone());
                            Some(win_thumb.clone())
                        }
                    }
                } else {
                    // Windows has no thumbnail, but we have cache - use cache
                    Some(cached)
                }
            } else {
                // Same track, cache is valid
                Some(cached)
            }
        } else {
            let encoded = thumbnail_to_base64(&media_props);
            if let Some(ref img) = encoded {
                // Only check for stale thumbnails when the track has actually changed
                // If same track, matching thumbnail is expected and correct
                let track_changed = previous_title.map(|prev| prev != title).unwrap_or(false);
                let is_stale = if track_changed {
                    // Check if this "new" thumbnail matches the previous track's thumbnail
                    // This detects Windows GSMTC returning stale data when track changes quickly
                    if let Some(prev_thumb) = previous_thumbnail {
                        img == prev_thumb
                    } else {
                        false
                    }
                } else {
                    false // Same track, so matching thumbnail is expected
                };

                if is_stale {
                    log::warn!("Fetched thumbnail for '{}' matches previous track's image (len: {}), likely stale from Windows GSMTC. Skipping thumbnail this cycle - will refetch on next poll.", 
                        title, img.len());

                    // Don't cache or return the stale thumbnail
                    // Return None so the snapshot emits without an image
                    // Next poll cycle (100ms later) will fetch it fresh as a cache MISS
                    None
                } else {
                    // Fresh thumbnail, cache it normally
                    guard.insert(cache_key.clone(), img.clone());

                    // IMPORTANT: Mark this title as the last one we successfully cached
                    // This will be used on next poll to detect stale thumbnails
                    // Must happen in snapshot_from_session to ensure it's updated even if
                    // the snapshot isn't emitted due to no changes
                    encoded
                }
            } else {
                encoded
            }
        }
    } else {
        thumbnail_to_base64(&media_props)
    };

    Ok(MediaSnapshotDto {
        props: MediaPropsDto {
            title,
            artist,
            album_title,
            album_image,
        },
        is_playing,
        position_ms,
        duration_ms,
        is_shuffle,
        repeat_mode,
        source_app_id,
    })
}

// Background GSMTC polling loop.
// Emits "media_snapshot" with MediaSnapshotDto and updates MediaState.snapshot.
#[cfg(target_os = "windows")]
async fn start_gsmtc_polling(app: AppHandle, state: Arc<MediaState>) {
    let mgr_op = GlobalSystemMediaTransportControlsSessionManager::RequestAsync();
    let mgr = match mgr_op {
        Ok(op) => match op.get() {
            Ok(m) => m,
            Err(e) => {
                log::error!("GSMTC RequestAsync get failed: {:?}", e);
                return;
            }
        },
        Err(e) => {
            log::error!("GSMTC RequestAsync failed: {:?}", e);
            return;
        }
    };

    loop {
        // Try to get current session; if it fails or is absent, just wait and retry.
        let session = match mgr.GetCurrentSession() {
            Ok(s) => s,
            Err(e) => {
                // Some Windows APIs (via the `windows` crate) can return an Err
                // whose HRESULT is 0 (S_OK). Treat that as non-fatal/no-session
                // to avoid surfacing spurious errors to the frontend.
                if e.code().0 != 0 {
                    log::debug!("GetCurrentSession error in poll loop: {:?}", e);
                }
                sleep(Duration::from_millis(500)).await;
                continue;
            }
        };

        // Extract previous thumbnail and last cached title before calling snapshot_from_session
        let prev_thumbnail = {
            let snapshot_guard = state.snapshot.lock().await;
            snapshot_guard
                .as_ref()
                .and_then(|s| s.props.album_image.clone())
        };
        let last_cached_title = state.last_cached_title.lock().await.clone();

        let snap = match snapshot_from_session(
            &session,
            Some(&state.thumbnail_cache),
            prev_thumbnail.as_ref(),
            last_cached_title.as_deref(),
        ) {
            Ok(s) => s,
            Err(e) => {
                log::debug!("snapshot_from_session failed: {}", e);
                sleep(Duration::from_millis(500)).await;
                continue;
            }
        };

        let mut snapshot_guard = state.snapshot.lock().await;
        let should_emit = if let Some(ref old_snap) = *snapshot_guard {
            // Check if media properties changed (title, artist, album)
            // This is critical for detecting track changes even if other fields haven't updated
            let media_changed = old_snap.props != snap.props;
            let playback_changed = old_snap.is_playing != snap.is_playing
                || old_snap.is_shuffle != snap.is_shuffle
                || old_snap.repeat_mode != snap.repeat_mode;
            let source_changed = old_snap.source_app_id != snap.source_app_id;

            // Always emit if media properties changed (new track)
            if media_changed {
                log::info!(
                    "Track changed: {} -> {}",
                    old_snap.props.title,
                    snap.props.title
                );

                // Invalidate thumbnail cache for the old track to force fresh fetch
                // This handles cases where Windows GSMTC returns stale thumbnail on track change
                if let Ok(mut cache) = state.thumbnail_cache.lock() {
                    let use_album = old_snap
                        .props
                        .album_title
                        .as_ref()
                        .map(|a| !a.is_empty())
                        .unwrap_or(false);
                    let old_key = if use_album {
                        format!(
                            "{}\x1F{}",
                            old_snap.source_app_id.as_deref().unwrap_or(""),
                            old_snap.props.album_title.as_deref().unwrap()
                        )
                    } else {
                        format!(
                            "{}\x1F{}",
                            old_snap.source_app_id.as_deref().unwrap_or(""),
                            old_snap.props.title
                        )
                    };
                    cache.remove(&old_key);
                }
            }

            media_changed || playback_changed || source_changed || old_snap != &snap
        } else {
            true // First snapshot
        };

        // Check playing status before snap is moved
        let is_playing = snap.is_playing;

        if should_emit {
            // Always update last_cached_title to current track title
            // This is used for stale detection on the NEXT poll cycle
            // Even if we skip this thumbnail, we want to compare against the current
            // title on next fetch to continue detecting staleness
            let mut last_title_guard = state.last_cached_title.lock().await;
            *last_title_guard = Some(snap.props.title.clone());

            *snapshot_guard = Some(snap.clone());
            drop(snapshot_guard); // Release snapshot lock before acquiring props lock

            let mut props_guard = state.props.lock().await;
            *props_guard = Some(snap.props.clone());
            drop(props_guard); // Release props lock before emitting

            let _ = app.emit("media_snapshot", snap);
        } else {
            drop(snapshot_guard);
        }

        // Poll more frequently when playing to catch track changes faster
        let poll_interval = if is_playing { 100 } else { 300 };
        sleep(Duration::from_millis(poll_interval)).await;
    }
}

// ---------------------------------------------------------------------------

#[tauri::command]
#[cfg(target_os = "windows")]
async fn start_media_listener(
    app_handle: AppHandle,
    state: State<'_, Arc<MediaState>>,
) -> Result<(), String> {
    let state_arc = state.inner().clone();

    if state_arc.listener_started.swap(true, Ordering::SeqCst) {
        log::debug!("start_media_listener called again; listener already running");
        return Ok(());
    }

    // Spawn gsmTc polling loop (defensive, helps with TIDAL etc.).
    {
        let app = app_handle.clone();
        let st = state_arc.clone();
        tauri::async_runtime::spawn(async move {
            start_gsmtc_polling(app, st).await;
        });
    }

    // Keep your existing gsmtc-based listener (good, low-latency for many apps).
    tauri::async_runtime::spawn(async move {
        // Manager events receiver
        let mut mgr_rx: UnboundedReceiver<ManagerEvent> = match SessionManager::create().await {
            Ok(rx) => rx,
            Err(e) => {
                log::error!("Failed to create SessionManager: {:?}", e);
                return;
            }
        };

        // Track a single current-session updates receiver for simplicity
        let mut current_session_rx: Option<UnboundedReceiver<SessionUpdateEvent>> = None;

        while let Some(evt) = mgr_rx.recv().await {
            match evt {
                ManagerEvent::SessionCreated {
                    session_id,
                    rx,
                    source,
                } => {
                    log::debug!("SessionCreated id={} source={}", session_id, source);
                    // If we don't have a session yet, treat the first one as current
                    if current_session_rx.is_none() {
                        current_session_rx = Some(rx);
                    }
                }
                ManagerEvent::CurrentSessionChanged { session_id } => {
                    log::debug!("CurrentSessionChanged: {:?}", session_id);
                    // For a full solution, you’d maintain a map from session_id to its rx,
                    // and switch current_session_rx here. Kept simple for now.
                    let _ = session_id;
                }
                ManagerEvent::SessionRemoved { session_id } => {
                    log::debug!("SessionRemoved id={}", session_id);
                    // In a full solution, drop the corresponding rx if it was current.
                }
            }

            // Drain updates from the current session, if any
            if let Some(rx) = current_session_rx.as_mut() {
                while let Ok(update) = rx.try_recv() {
                    if let SessionUpdateEvent::Media(session_model, image) = update {
                        let album_image = image
                            .and_then(|img| Some(img.data))
                            .map(|bytes| BASE64.encode(bytes));

                        let title = session_model
                            .media
                            .as_ref()
                            .map(|m| m.title.clone())
                            .unwrap_or_default();

                        let artist = session_model
                            .media
                            .as_ref()
                            .map(|m| m.artist.clone())
                            .unwrap_or_default();

                        let album_title = session_model
                            .media
                            .as_ref()
                            .and_then(|m| m.album.clone().map(|a| a.title));

                        log::debug!(
                            "gsmtc listener update: {} - {} (album: {:?}, has_image: {})",
                            title,
                            artist,
                            album_title,
                            album_image.is_some()
                        );

                        let dto = MediaPropsDto {
                            title,
                            artist,
                            album_title,
                            album_image,
                        };

                        {
                            let mut guard = state_arc.props.lock().await;
                            *guard = Some(dto.clone());
                        }

                        let _ = app_handle.emit("media_update", dto);
                    }
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
#[cfg(target_os = "linux")]
async fn start_media_listener(
    app_handle: AppHandle,
    state: State<'_, Arc<MediaState>>,
) -> Result<(), String> {
    let state_arc = state.inner().clone();

    if state_arc.listener_started.swap(true, Ordering::SeqCst) {
        log::debug!("start_media_listener called again; listener already running");
        return Ok(());
    }

    tauri::async_runtime::spawn(async move {
        let mut pending_source_switch: Option<(String, Instant)> = None;

        loop {
            let previous_snapshot = {
                let snapshot_guard = state_arc.snapshot.lock().await;
                snapshot_guard.clone()
            };

            let preferred_source = previous_snapshot.as_ref().and_then(|existing| {
                if !existing.is_playing {
                    return None;
                }

                let normalized = normalize_source_app_id(existing.source_app_id.as_deref());
                if normalized.is_empty() {
                    None
                } else {
                    Some(normalized)
                }
            });
            let preferred_source_ref = preferred_source.as_deref().filter(|source| !source.is_empty());

            match refresh_linux_snapshot_sync(
                Some(&state_arc.thumbnail_cache),
                preferred_source_ref,
            ) {
                Ok(Some(mut snap)) => {
                    sanitize_suspicious_track_position(previous_snapshot.as_ref(), &mut snap);

                    let previous_source = previous_snapshot
                        .as_ref()
                        .map(|existing| normalize_source_app_id(existing.source_app_id.as_deref()))
                        .unwrap_or_default();
                    let incoming_source = normalize_source_app_id(snap.source_app_id.as_deref());

                    if is_suspicious_source_flip(previous_snapshot.as_ref(), &snap) {
                        log::debug!(
                            "linux: suppress suspicious source flip prev_source={} prev_playing={} prev_title='{}' incoming_source={} incoming_playing={} incoming_title='{}'",
                            previous_source,
                            previous_snapshot.as_ref().map(|s| s.is_playing).unwrap_or(false),
                            previous_snapshot
                                .as_ref()
                                .map(|s| s.props.title.as_str())
                                .unwrap_or(""),
                            incoming_source,
                            snap.is_playing,
                            snap.props.title,
                        );
                        sleep(Duration::from_millis(140)).await;
                        continue;
                    }

                    let source_changed = !previous_source.is_empty()
                        && !incoming_source.is_empty()
                        && previous_source != incoming_source;

                    if source_changed {
                        let should_confirm = match pending_source_switch.as_ref() {
                            Some((candidate_source, started_at)) if candidate_source == &incoming_source => {
                                started_at.elapsed() < Duration::from_millis(320)
                            }
                            _ => true,
                        };

                        if should_confirm {
                            if !matches!(pending_source_switch.as_ref(), Some((candidate_source, _)) if candidate_source == &incoming_source)
                            {
                                pending_source_switch = Some((incoming_source.clone(), Instant::now()));
                            }

                            log::debug!(
                                "linux: holding source switch for confirmation prev_source={} incoming_source={} title='{}' playing={}",
                                previous_source,
                                incoming_source,
                                snap.props.title,
                                snap.is_playing,
                            );

                            // Wait for another poll from the same source before accepting
                            // a source switch. This filters transient MPRIS source blips
                            // that can happen during track transitions.
                            sleep(Duration::from_millis(120)).await;
                            continue;
                        }

                        log::debug!(
                            "linux: accepted source switch prev_source={} incoming_source={} title='{}' playing={}",
                            previous_source,
                            incoming_source,
                            snap.props.title,
                            snap.is_playing,
                        );
                        pending_source_switch = None;
                    } else {
                        pending_source_switch = None;
                    }

                    let previous_props = {
                        previous_snapshot.as_ref().map(|existing| existing.props.clone())
                    };

                    let mut snapshot_guard = state_arc.snapshot.lock().await;
                    let should_emit = snapshot_guard.as_ref() != Some(&snap);

                    if should_emit {
                        let props_changed = previous_props.as_ref() != Some(&snap.props);

                        *snapshot_guard = Some(snap.clone());
                        drop(snapshot_guard);

                        let mut props_guard = state_arc.props.lock().await;
                        *props_guard = Some(snap.props.clone());
                        drop(props_guard);

                        if props_changed {
                            let _ = app_handle.emit("media_update", snap.props.clone());
                        }

                        log::debug!(
                            "linux: emit media_snapshot source={} playing={} title='{}' artist='{}' position_ms={:?} duration_ms={:?} has_image={}",
                            incoming_source,
                            snap.is_playing,
                            snap.props.title,
                            snap.props.artist,
                            snap.position_ms,
                            snap.duration_ms,
                            snap.props.album_image.is_some(),
                        );

                        let _ = app_handle.emit("media_snapshot", snap.clone());

                        let poll_interval = if snap.is_playing { 250 } else { 500 };
                        sleep(Duration::from_millis(poll_interval)).await;
                    } else {
                        drop(snapshot_guard);
                        sleep(Duration::from_millis(500)).await;
                    }
                }
                Ok(None) => {
                    sleep(Duration::from_millis(750)).await;
                }
                Err(error) => {
                    log::debug!("Linux media poll failed: {}", error);
                    sleep(Duration::from_secs(1)).await;
                }
            }
        }
    });

    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum MediaAction {
    PlayPause,
    Next,
    Previous,
}

#[cfg(target_os = "windows")]
fn control_current_session_sync(action: MediaAction) -> Result<(), String> {
    // Request manager
    let op = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
        .map_err(|e| format!("RequestAsync failed: {e:?}"))?;
    let mgr: GlobalSystemMediaTransportControlsSessionManager = op
        .get()
        .map_err(|e| format!("RequestAsync get failed: {e:?}"))?;

    // Get current session
    let session = match mgr.GetCurrentSession() {
        Ok(s) => s,
        Err(e) => {
            // Some Windows APIs (via the `windows` crate) can return an Err
            // whose HRESULT is 0 (S_OK). Treat that as non-fatal/no-session
            // to avoid surfacing spurious errors to the frontend.
            if e.code().0 == 0 {
                log::debug!("GetCurrentSession returned spurious S_OK Err in control_current_session_sync: {:?}", e);
                return Ok(());
            } else {
                return Err(format!("GetCurrentSession failed: {e:?}"));
            }
        }
    };
    // If there is no session, GetCurrentSession returns an error, so no IsNull check here.

    match action {
        MediaAction::PlayPause => {
            let op = session
                .TryTogglePlayPauseAsync()
                .map_err(|e| format!("TryTogglePlayPauseAsync failed: {e:?}"))?;
            let _res = op.get().map_err(|e| format!("Toggle get failed: {e:?}"))?;
        }
        MediaAction::Next => {
            let op = session
                .TrySkipNextAsync()
                .map_err(|e| format!("TrySkipNextAsync failed: {e:?}"))?;
            let _res = op
                .get()
                .map_err(|e| format!("SkipNext get failed: {e:?}"))?;
        }
        MediaAction::Previous => {
            let op = session
                .TrySkipPreviousAsync()
                .map_err(|e| format!("TrySkipPreviousAsync failed: {e:?}"))?;
            let _res = op
                .get()
                .map_err(|e| format!("SkipPrevious get failed: {e:?}"))?;
        }
    }

    Ok(())
}

#[cfg(target_os = "linux")]
fn control_current_session_sync(
    action: MediaAction,
    preferred_source_normalized: Option<&str>,
) -> Result<(), String> {
    let Some(player) = get_active_linux_player(preferred_source_normalized)? else {
        return Ok(());
    };

    match action {
        MediaAction::PlayPause => {
            let _ = player
                .checked_play_pause()
                .map_err(|e| format!("Failed to toggle MPRIS playback: {e:?}"))?;
        }
        MediaAction::Next => {
            let _ = player
                .checked_next()
                .map_err(|e| format!("Failed to skip to next MPRIS track: {e:?}"))?;
        }
        MediaAction::Previous => {
            let _ = player
                .checked_previous()
                .map_err(|e| format!("Failed to skip to previous MPRIS track: {e:?}"))?;
        }
    }

    Ok(())
}

#[tauri::command]
#[cfg(target_os = "windows")]
async fn control_media(action: MediaAction) -> Result<(), String> {
    control_current_session_sync(action)
}

#[tauri::command]
#[cfg(target_os = "linux")]
async fn control_media(
    action: MediaAction,
    state: State<'_, Arc<MediaState>>,
) -> Result<(), String> {
    let preferred_source = get_preferred_source_normalized(state.inner()).await;
    control_current_session_sync(action, preferred_source.as_deref())
}

#[tauri::command]
#[cfg(target_os = "windows")]
async fn seek_to(position_ms: i64) -> Result<(), String> {
    // Request manager
    let op = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
        .map_err(|e| format!("RequestAsync failed: {e:?}"))?;
    let mgr = op
        .get()
        .map_err(|e| format!("RequestAsync get failed: {e:?}"))?;

    // Get current session
    let session = match mgr.GetCurrentSession() {
        Ok(s) => s,
        Err(e) => {
            // Some Windows APIs (via the `windows` crate) can return an Err
            // whose HRESULT is 0 (S_OK). Treat that as non-fatal/no-session
            // to avoid surfacing spurious errors to the frontend.
            if e.code().0 == 0 {
                log::debug!(
                    "GetCurrentSession returned spurious S_OK Err in seek_to: {:?}",
                    e
                );
                return Ok(());
            } else {
                return Err(format!("GetCurrentSession failed: {e:?}"));
            }
        }
    };

    // Convert ms to 100‑ns ticks
    let requested_ticks = position_ms * 10_000;

    let op = session
        .TryChangePlaybackPositionAsync(requested_ticks)
        .map_err(|e| format!("TryChangePlaybackPositionAsync failed: {e:?}"))?;

    let _ = op.get().map_err(|e| format!("Seek get failed: {e:?}"))?;

    Ok(())
}

#[tauri::command]
#[cfg(target_os = "linux")]
async fn seek_to(
    position_ms: i64,
    state: State<'_, Arc<MediaState>>,
) -> Result<(), String> {
    let preferred_source = get_preferred_source_normalized(state.inner()).await;
    let Some(player) = get_active_linux_player(preferred_source.as_deref())? else {
        return Ok(());
    };

    let metadata = player
        .get_metadata()
        .map_err(|e| format!("Failed to get MPRIS metadata before seek: {e:?}"))?;
    let Some(track_id) = metadata.track_id() else {
        return Ok(());
    };

    let target_position = Duration::from_millis(position_ms.max(0) as u64);
    let _ = player
        .checked_set_position(track_id, &target_position)
        .map_err(|e| format!("Failed to seek via MPRIS: {e:?}"))?;

    Ok(())
}

#[tauri::command]
#[cfg(target_os = "windows")]
async fn refresh_media_snapshot(
    app: tauri::AppHandle,
    state: State<'_, Arc<MediaState>>,
) -> Result<(), String> {
    let op = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
        .map_err(|e| format!("RequestAsync failed: {e:?}"))?;
    let mgr = op
        .get()
        .map_err(|e| format!("RequestAsync get failed: {e:?}"))?;

    let session = match mgr.GetCurrentSession() {
        Ok(s) => s,
        Err(e) => {
            // Some Windows APIs (via the `windows` crate) can return an Err
            // whose HRESULT is 0 (S_OK). Treat that as non-fatal/no-session
            // to avoid surfacing spurious errors to the frontend.
            if e.code().0 == 0 {
                log::debug!(
                    "GetCurrentSession returned spurious S_OK Err in refresh_media_snapshot: {:?}",
                    e
                );
                return Ok(());
            } else {
                return Err(format!("GetCurrentSession failed: {e:?}"));
            }
        }
    };

    // Get previous snapshot data to preserve thumbnail cache and title
    let (prev_thumbnail, prev_title) = {
        let snapshot_guard = state.snapshot.lock().await;
        if let Some(ref prev_snap) = *snapshot_guard {
            (
                prev_snap.props.album_image.clone(),
                Some(prev_snap.props.title.clone()),
            )
        } else {
            (None, None)
        }
    };

    let snap = snapshot_from_session(
        &session,
        Some(&state.thumbnail_cache),
        prev_thumbnail.as_ref(),
        prev_title.as_deref(),
    )?;

    let mut snapshot_guard = state.snapshot.lock().await;
    *snapshot_guard = Some(snap.clone());
    drop(snapshot_guard);

    let mut props_guard = state.props.lock().await;
    *props_guard = Some(snap.props.clone());
    drop(props_guard);

    let _ = app.emit("media_snapshot", snap);
    Ok(())
}

#[tauri::command]
#[cfg(target_os = "linux")]
async fn refresh_media_snapshot(
    app: tauri::AppHandle,
    state: State<'_, Arc<MediaState>>,
) -> Result<(), String> {
    let previous_snapshot = {
        let snapshot_guard = state.snapshot.lock().await;
        snapshot_guard.clone()
    };

    let preferred_source = previous_snapshot.as_ref().and_then(|existing| {
        if !existing.is_playing {
            return None;
        }

        let normalized = normalize_source_app_id(existing.source_app_id.as_deref());
        if normalized.is_empty() {
            None
        } else {
            Some(normalized)
        }
    });
    let preferred_source_ref = preferred_source.as_deref();

    let Some(mut snap) = refresh_linux_snapshot_sync(
        Some(&state.thumbnail_cache),
        preferred_source_ref,
    )? else {
        return Ok(());
    };

    sanitize_suspicious_track_position(previous_snapshot.as_ref(), &mut snap);

    if is_suspicious_source_flip(previous_snapshot.as_ref(), &snap) {
        log::debug!(
            "linux: refresh ignored suspicious flip prev_source={} prev_playing={} prev_title='{}' incoming_source={} incoming_playing={} incoming_title='{}'",
            previous_snapshot
                .as_ref()
                .map(|s| normalize_source_app_id(s.source_app_id.as_deref()))
                .unwrap_or_default(),
            previous_snapshot.as_ref().map(|s| s.is_playing).unwrap_or(false),
            previous_snapshot
                .as_ref()
                .map(|s| s.props.title.as_str())
                .unwrap_or(""),
            normalize_source_app_id(snap.source_app_id.as_deref()),
            snap.is_playing,
            snap.props.title,
        );
        return Ok(());
    }

    let mut snapshot_guard = state.snapshot.lock().await;
    *snapshot_guard = Some(snap.clone());
    drop(snapshot_guard);

    let mut props_guard = state.props.lock().await;
    *props_guard = Some(snap.props.clone());
    drop(props_guard);

    log::debug!(
        "linux: refresh emit media_snapshot source={} playing={} title='{}' artist='{}' position_ms={:?} duration_ms={:?} has_image={}",
        normalize_source_app_id(snap.source_app_id.as_deref()),
        snap.is_playing,
        snap.props.title,
        snap.props.artist,
        snap.position_ms,
        snap.duration_ms,
        snap.props.album_image.is_some(),
    );

    let _ = app.emit("media_snapshot", snap.clone());
    let _ = app.emit("media_update", snap.props.clone());
    Ok(())
}

#[cfg(target_os = "windows")]
use windows::Media::Control::GlobalSystemMediaTransportControlsSessionMediaProperties;
#[cfg(target_os = "windows")]
use windows::Storage::Streams::DataReader;

#[cfg(target_os = "windows")]
fn thumbnail_to_base64(
    props: &GlobalSystemMediaTransportControlsSessionMediaProperties,
) -> Option<String> {
    // Thumbnail is an IRandomAccessStreamReference
    let thumb_ref = props.Thumbnail().ok()?;
    let stream_op = thumb_ref.OpenReadAsync().ok()?;
    let stream = stream_op.get().ok()?;

    let size = stream.Size().ok()? as u32;
    if size == 0 {
        return None;
    }

    let reader = DataReader::CreateDataReader(&stream).ok()?;
    // Load async -> get
    let load_op = reader.LoadAsync(size).ok()?;
    let _ = load_op.get().ok()?;

    let mut buf = vec![0u8; size as usize];
    reader.ReadBytes(&mut buf).ok()?;

    Some(BASE64.encode(buf))
}

fn main() {
    tauri::Builder::default()
        .manage(Arc::new(MediaState::default()))
        .invoke_handler(tauri::generate_handler![
            get_current_media,
            start_media_listener,
            control_media,
            set_shuffle,
            set_repeat,
            seek_to,
            refresh_media_snapshot,
            fetch_lyrics,
            configure_window_menu
        ])
        .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // When the main window is closed, quit the entire application
                if window.label() == "main" {
                    log::info!("Main window close requested, quitting application");
                    std::process::exit(0);
                }
            }
        })
        .setup(|app| {
            #[cfg(target_os = "windows")]
            {
                use raw_window_handle::{HasWindowHandle, RawWindowHandle};
                use tauri::Manager;

                // Show splash screen immediately
                if let Some(splash) = app.get_webview_window("splashscreen") {
                    splash.show().ok();
                }

                // Configure main window only (lyrics window is created dynamically and configured separately)
                if let Some(window) = app.get_webview_window("main") {
                    // Get both window and webview HWNDs to disable context menu
                    if let Ok(handle) = window.window_handle() {
                        if let RawWindowHandle::Win32(win_handle) = handle.as_raw() {
                            unsafe {
                                let hwnd = HWND(win_handle.hwnd.get() as _);

                                // Remove maximize and minimize from window style
                                let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
                                let new_style = style
                                    & !(WS_MAXIMIZEBOX.0 as isize)
                                    & !(WS_MINIMIZEBOX.0 as isize);
                                SetWindowLongPtrW(hwnd, GWL_STYLE, new_style);

                                // Remove items from system menu
                                let hmenu = GetSystemMenu(hwnd, false);
                                if !hmenu.is_invalid() {
                                    DeleteMenu(hmenu, SC_MAXIMIZE, MF_BYCOMMAND).ok();
                                    DeleteMenu(hmenu, SC_MINIMIZE, MF_BYCOMMAND).ok();
                                    DeleteMenu(hmenu, SC_RESTORE, MF_BYCOMMAND).ok();
                                    DeleteMenu(hmenu, SC_SIZE, MF_BYCOMMAND).ok();
                                }

                                // Subclass the window to intercept WM_CONTEXTMENU
                                let old_proc = SetWindowLongPtrW(
                                    hwnd,
                                    GWLP_WNDPROC,
                                    custom_wndproc as *const () as isize,
                                );
                                let mut old_procs = OLD_WNDPROCS.lock().unwrap();
                                old_procs.insert(hwnd.0 as isize, old_proc);
                                drop(old_procs);

                                log::info!("Window 'main' configured - HWND: {:?}", hwnd);
                            }
                        }
                    }
                }

                if let Some(window) = app.get_webview_window("main") {
                    // Show main window after 1 second and close splash screen
                    let window_clone = window.clone();
                    let app_handle = app.handle().clone();
                    tauri::async_runtime::spawn(async move {
                        sleep(Duration::from_secs(1)).await;
                        window_clone.show().ok();
                        if let Some(splash) = app_handle.get_webview_window("splashscreen") {
                            splash.close().ok();
                        }
                    });
                }
            }

            #[cfg(not(target_os = "windows"))]
            {
                use tauri::{Manager};

                // Show splash screen immediately if present
                if let Some(splash) = app.get_webview_window("splashscreen") {
                    // workaround for the min 200px size constraint on Linux
                    splash.set_resizable(true).ok();                    
                    if let Ok(size) = splash.inner_size() {
                        log::debug!("splash size: {}x{}", size.width, size.height);
                    }                    
                    splash.show().ok();
                }

                // Show main window after a short delay and close splash
                if let Some(window) = app.get_webview_window("main") {
                    // workaround for the min 200px size constraint on Linux
                    window.set_resizable(true).ok();                    
                    if let Ok(size) = window.inner_size() {
                        log::debug!("main size (before show): {}x{}", size.width, size.height);
                    }
                    let window_clone = window.clone();
                    let app_handle = app.handle().clone();
                    tauri::async_runtime::spawn(async move {
                        sleep(Duration::from_secs(1)).await;
                        window_clone.show().ok();
                        if let Some(splash) = app_handle.get_webview_window("splashscreen") {
                            splash.close().ok();
                        }
                    });
                }
            }

            #[cfg(not(debug_assertions))]
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    check_for_updates(handle).await;
                });
            }

            #[cfg(debug_assertions)]
            log::info!("Skipping update check in development mode");

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[derive(Clone, Serialize)]
#[allow(dead_code)]
struct UpdateInfo {
    version: String,
    current_version: String,
}

#[allow(dead_code)]
async fn check_for_updates(app: AppHandle) {
    // Get current version
    let current_version = app.package_info().version.to_string();

    match app.updater().ok() {
        Some(updater) => {
            match updater.check().await {
                Ok(Some(update)) => {
                    log::info!(
                        "Update available: {} (current: {})",
                        update.version,
                        current_version
                    );

                    // Emit event to frontend to notify user that update is available and starting download
                    let update_info = UpdateInfo {
                        version: update.version.clone(),
                        current_version: current_version.clone(),
                    };
                    let _ = app.emit("update-available", &update_info);

                    // Download and install the update
                    let version_clone = update.version.clone();
                    match update
                        .download_and_install(
                            |_chunk_length, _content_length| {
                                // Progress callback - could emit progress events here if needed
                            },
                            || {
                                // Download completed callback
                                log::info!("Update downloaded, will install on app restart");
                            },
                        )
                        .await
                    {
                        Ok(_) => {
                            log::info!("Update ready to install");
                            let ready_info = UpdateInfo {
                                version: version_clone,
                                current_version,
                            };
                            let _ = app.emit("update-downloaded", &ready_info);
                        }
                        Err(e) => {
                            log::error!("Failed to download update: {}", e);
                            let _ = app.emit("update-error", format!("{}", e));
                        }
                    }
                }
                Ok(None) => {
                    log::info!(
                        "No updates available - running latest version {}",
                        current_version
                    );
                }
                Err(e) => {
                    log::warn!("Failed to check for updates: {}", e);
                }
            }
        }
        None => {
            log::warn!("Updater not available");
        }
    }
}
