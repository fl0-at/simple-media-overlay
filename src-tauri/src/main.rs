#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use std::sync::Arc;
use std::collections::HashMap;
use std::sync::Mutex as StdMutex;
use std::time::Duration;

use gsmtc::{ManagerEvent, SessionManager, SessionUpdateEvent};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::UpdaterExt;
use tokio::sync::{mpsc::UnboundedReceiver, Mutex};
use tokio::time::sleep;

use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession, GlobalSystemMediaTransportControlsSessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus,
};
use windows::Media::MediaPlaybackAutoRepeatMode;

#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{WM_CONTEXTMENU, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_NCRBUTTONDOWN, WM_NCRBUTTONUP, WM_SYSCOMMAND, SC_MAXIMIZE, SC_MINIMIZE, SC_RESTORE, SC_SIZE, DefWindowProcW, SetWindowLongPtrW, CallWindowProcW, GWLP_WNDPROC, GetWindowLongPtrW, GWL_STYLE, WS_MAXIMIZEBOX, WS_MINIMIZEBOX, GetSystemMenu, DeleteMenu, MF_BYCOMMAND};

#[cfg(target_os = "windows")]
static mut OLD_WNDPROC: Option<isize> = None;

#[cfg(target_os = "windows")]
unsafe extern "system" fn custom_wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    // Block the context menu and all right-click related messages
    match msg {
        WM_CONTEXTMENU | WM_RBUTTONDOWN | WM_RBUTTONUP | WM_NCRBUTTONDOWN | WM_NCRBUTTONUP => {
            return LRESULT(0);
        }
        WM_SYSCOMMAND => {
            // Block maximize, minimize, restore, and size commands
            let cmd = wparam.0 & 0xFFF0;
            if cmd == SC_MAXIMIZE as usize || cmd == SC_MINIMIZE as usize || cmd == SC_RESTORE as usize || cmd == SC_SIZE as usize {
                return LRESULT(0);
            }
        }
        _ => {}
    }
    
    // Call the original window procedure for all other messages
    if let Some(old_proc) = OLD_WNDPROC {
        CallWindowProcW(
            Some(std::mem::transmute(old_proc)),
            hwnd,
            msg,
            wparam,
            lparam,
        )
    } else {
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

fn with_current_session<F>(f: F) -> Result<(), String>
where
    F: FnOnce(GlobalSystemMediaTransportControlsSession) -> Result<(), String>,
{
    let op = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
        .map_err(|e| format!("RequestAsync failed: {e:?}"))?;
    let mgr = op
        .get()
        .map_err(|e| format!("RequestAsync get failed: {e:?}"))?;

    let session = mgr
        .GetCurrentSession()
        .map_err(|e| format!("GetCurrentSession failed: {e:?}"))?;

    f(session)
}

fn set_shuffle_sync(active: bool) -> Result<(), String> {
    with_current_session(|session| {
        let op = session
            .TryChangeShuffleActiveAsync(active)
            .map_err(|e| format!("TryChangeShuffleActiveAsync failed: {e:?}"))?;
        let _ = op.get().map_err(|e| format!("Shuffle get failed: {e:?}"))?;
        Ok(())
    })
}

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

#[tauri::command]
async fn set_shuffle(active: bool) -> Result<(), String> {
    set_shuffle_sync(active)
}

#[tauri::command]
async fn set_repeat(mode: RepeatMode) -> Result<(), String> {
    set_repeat_sync(mode)
}

#[tauri::command]
async fn fetch_lyrics(track_name: String, artist_name: String, album_name: Option<String>, duration_ms: Option<i64>, state: State<'_, Arc<MediaState>>) -> Result<LyricsResponse, String> {
    // Create cache key from artist and track name
    let cache_key = format!("{}|{}", artist_name.to_lowercase(), track_name.to_lowercase());
    
    // Check cache first
    {
        let cache = state.lyrics_cache.lock().unwrap();
        if let Some(cached_lyrics) = cache.get(&cache_key) {
            return Ok(cached_lyrics.clone());
        }
    }
    
    // Build LRCLIB API URL
    let base_url = "https://lrclib.net/api/get";
    let mut url = format!("{}?track_name={}&artist_name={}", 
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
    
    // Make the HTTP request
    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .header("User-Agent", "simple-media-overlay/0.10.5")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "Request timed out. Please check your internet connection.".to_string()
            } else if e.is_connect() {
                "Cannot connect to lyrics service. Please check your internet connection.".to_string()
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
        // No lyrics found - cache the negative result to avoid repeated API calls
        let empty_response = LyricsResponse {
            plain_lyrics: None,
            synced_lyrics: None,
            instrumental: false,
        };
        
        {
            let mut cache = state.lyrics_cache.lock().unwrap();
            cache.insert(cache_key, empty_response.clone());
        }
        
        Err("No lyrics found".to_string())
    } else if status.as_u16() == 429 {
        // Rate limited - don't cache this
        Err("Rate limit exceeded. Please try again later.".to_string())
    } else if status.is_client_error() {
        // 4xx errors (except 404 and 429)
        Err(format!("Invalid request ({}). Please try a different song.", status.as_u16()))
    } else if status.is_server_error() {
        // 5xx errors - server issues
        Err(format!("Lyrics service temporarily unavailable ({}). Please try again later.", status.as_u16()))
    } else {
        // Unexpected status
        Err(format!("Unexpected response from lyrics service: {}", status))
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
    last_cached_title: Mutex<Option<String>>,
    // Cache of lyrics keyed by (artist|title)
    lyrics_cache: StdMutex<HashMap<String, LyricsResponse>>,
}

#[tauri::command]
async fn get_current_media(
    state: State<'_, Arc<MediaState>>,
) -> Result<Option<MediaPropsDto>, String> {
    Ok(state.props.lock().await.clone())
}

// --- GSMTC snapshot/polling helpers ---------------------------------------

fn map_repeat_mode_enum(mode: MediaPlaybackAutoRepeatMode) -> RepeatMode {
    match mode {
        MediaPlaybackAutoRepeatMode::Track => RepeatMode::Track,
        MediaPlaybackAutoRepeatMode::List => RepeatMode::List,
        _ => RepeatMode::None,
    }
}

// Build a full snapshot from a GSMTC session (polling path).
fn snapshot_from_session(
    session: &GlobalSystemMediaTransportControlsSession,
    cache: Option<&StdMutex<HashMap<String, String>>>,
    previous_thumbnail: Option<&String>,    previous_title: Option<&str>,) -> Result<MediaSnapshotDto, String> {
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
    let use_album_for_cache = album_title.as_ref()
        .map(|a| !a.is_empty())
        .unwrap_or(false);
    
    let cache_key = if use_album_for_cache {
        // Use album title for caching (all tracks on same album share art)
        format!("{}\x1F{}", 
            source_app_id.as_deref().unwrap_or(""),
            album_title.as_deref().unwrap())
    } else {
        // Use track title for caching (each track has its own art)
        format!("{}\x1F{}", 
            source_app_id.as_deref().unwrap_or(""),
            title)
    };

    let album_image = if let Some(cache_mutex) = cache {
        let mut guard = cache_mutex.lock().map_err(|_| "thumbnail_cache lock poisoned")?;
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
                // Only log truly failing HRESULTs; ignore S_OK noise.
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
            snapshot_guard.as_ref().and_then(|s| s.props.album_image.clone())
        };
        let last_cached_title = state.last_cached_title.lock().await.clone();

        let snap = match snapshot_from_session(
            &session, 
            Some(&state.thumbnail_cache), 
            prev_thumbnail.as_ref(),
            last_cached_title.as_deref()
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
                log::info!("Track changed: {} -> {}", 
                    old_snap.props.title, snap.props.title);
                
                // Invalidate thumbnail cache for the old track to force fresh fetch
                // This handles cases where Windows GSMTC returns stale thumbnail on track change
                if let Ok(mut cache) = state.thumbnail_cache.lock() {
                    let use_album = old_snap.props.album_title.as_ref()
                        .map(|a| !a.is_empty())
                        .unwrap_or(false);
                    let old_key = if use_album {
                        format!("{}\x1F{}", 
                            old_snap.source_app_id.as_deref().unwrap_or(""),
                            old_snap.props.album_title.as_deref().unwrap())
                    } else {
                        format!("{}\x1F{}", 
                            old_snap.source_app_id.as_deref().unwrap_or(""),
                            old_snap.props.title)
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
async fn start_media_listener(
    app_handle: AppHandle,
    state: State<'_, Arc<MediaState>>,
) -> Result<(), String> {
    let state_arc = state.inner().clone();

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

                        log::debug!("gsmtc listener update: {} - {} (album: {:?}, has_image: {})", 
                            title, artist, album_title, album_image.is_some());

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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum MediaAction {
    PlayPause,
    Next,
    Previous,
}

fn control_current_session_sync(action: MediaAction) -> Result<(), String> {
    // Request manager
    let op = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
        .map_err(|e| format!("RequestAsync failed: {e:?}"))?;
    let mgr: GlobalSystemMediaTransportControlsSessionManager = op
        .get()
        .map_err(|e| format!("RequestAsync get failed: {e:?}"))?;

    // Get current session
    let session: GlobalSystemMediaTransportControlsSession = mgr
        .GetCurrentSession()
        .map_err(|e| format!("GetCurrentSession failed: {e:?}"))?;
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

#[tauri::command]
async fn control_media(action: MediaAction) -> Result<(), String> {
    control_current_session_sync(action)
}

#[tauri::command]
async fn seek_to(position_ms: i64) -> Result<(), String> {
    // Request manager
    let op = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
        .map_err(|e| format!("RequestAsync failed: {e:?}"))?;
    let mgr = op
        .get()
        .map_err(|e| format!("RequestAsync get failed: {e:?}"))?;

    // Get current session
    let session = mgr
        .GetCurrentSession()
        .map_err(|e| format!("GetCurrentSession failed: {e:?}"))?;

    // Convert ms to 100‑ns ticks
    let requested_ticks = position_ms * 10_000;

    let op = session
        .TryChangePlaybackPositionAsync(requested_ticks)
        .map_err(|e| format!("TryChangePlaybackPositionAsync failed: {e:?}"))?;

    let _ = op.get().map_err(|e| format!("Seek get failed: {e:?}"))?;

    Ok(())
}

#[tauri::command]
async fn refresh_media_snapshot(
    app: tauri::AppHandle,
    state: State<'_, Arc<MediaState>>,
) -> Result<(), String> {
    let op = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
        .map_err(|e| format!("RequestAsync failed: {e:?}"))?;
    let mgr = op
        .get()
        .map_err(|e| format!("RequestAsync get failed: {e:?}"))?;

    let session = mgr
        .GetCurrentSession()
        .map_err(|e| format!("GetCurrentSession failed: {e:?}"))?;

    let snap = snapshot_from_session(&session, Some(&state.thumbnail_cache), None, None)?;

    let mut snapshot_guard = state.snapshot.lock().await;
    *snapshot_guard = Some(snap.clone());
    drop(snapshot_guard);
    
    let mut props_guard = state.props.lock().await;
    *props_guard = Some(snap.props.clone());
    drop(props_guard);

    let _ = app.emit("media_snapshot", snap);
    Ok(())
}

use windows::Media::Control::GlobalSystemMediaTransportControlsSessionMediaProperties;
use windows::Storage::Streams::DataReader;

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
            fetch_lyrics
        ])
        .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
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
                use tauri::Manager;
                use raw_window_handle::{HasWindowHandle, RawWindowHandle};
                
                // Show splash screen immediately
                if let Some(splash) = app.get_webview_window("splashscreen") {
                    splash.show().ok();
                }
                
                if let Some(window) = app.get_webview_window("main") {
                    // Get both window and webview HWNDs to disable context menu
                    if let Ok(handle) = window.window_handle() {
                        if let RawWindowHandle::Win32(win_handle) = handle.as_raw() {
                            unsafe {
                                let hwnd = HWND(win_handle.hwnd.get() as _);
                                
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
                                let old_proc = SetWindowLongPtrW(hwnd, GWLP_WNDPROC, custom_wndproc as isize);
                                OLD_WNDPROC = Some(old_proc);
                                
                                log::info!("Window subclassed to disable context menu - HWND: {:?}", hwnd);
                            }
                        }
                    }
                    
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
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    window.show().ok();
                    if let Some(splash) = app.get_webview_window("splashscreen") {
                        splash.close().ok();
                    }
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
                    log::info!("Update available: {} (current: {})", update.version, current_version);
                    
                    // Emit event to frontend to notify user that update is available and starting download
                    let update_info = UpdateInfo {
                        version: update.version.clone(),
                        current_version: current_version.clone(),
                    };
                    let _ = app.emit("update-available", &update_info);
                    
                    // Download and install the update
                    let version_clone = update.version.clone();
                    match update.download_and_install(|_chunk_length, _content_length| {
                        // Progress callback - could emit progress events here if needed
                    }, || {
                        // Download completed callback
                        log::info!("Update downloaded, will install on app restart");
                    }).await {
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
                    log::info!("No updates available - running latest version {}", current_version);
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
