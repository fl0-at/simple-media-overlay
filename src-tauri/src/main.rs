#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use std::sync::Arc;
use std::time::Duration;

use gsmtc::{ManagerEvent, SessionManager, SessionUpdateEvent};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc::UnboundedReceiver, Mutex};
use tokio::time::sleep;

use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession, GlobalSystemMediaTransportControlsSessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus,
};
use windows::Media::MediaPlaybackAutoRepeatMode;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum RepeatMode {
    None,
    Track,
    List,
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

    let album_image = thumbnail_to_base64(&media_props);

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

        let snap = match snapshot_from_session(&session) {
            Ok(s) => s,
            Err(e) => {
                log::debug!("snapshot_from_session failed: {}", e);
                sleep(Duration::from_millis(500)).await;
                continue;
            }
        };

        let mut guard = state.snapshot.lock().await;
        if guard.as_ref() != Some(&snap) {
            *guard = Some(snap.clone());
            {
                let mut props_guard = state.props.lock().await;
                *props_guard = Some(snap.props.clone());
            }
            let _ = app.emit("media_snapshot", snap);
        }

        sleep(Duration::from_millis(150)).await;
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

                        let dto = MediaPropsDto {
                            title: session_model
                                .media
                                .as_ref()
                                .map(|m| m.title.clone())
                                .unwrap_or_default(),
                            artist: session_model
                                .media
                                .as_ref()
                                .map(|m| m.artist.clone())
                                .unwrap_or_default(),
                            album_title: session_model
                                .media
                                .as_ref()
                                .and_then(|m| m.album.clone().map(|a| a.title)),
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

    let snap = snapshot_from_session(&session)?;

    {
        let mut guard = state.snapshot.lock().await;
        *guard = Some(snap.clone());
    }
    {
        let mut props_guard = state.props.lock().await;
        *props_guard = Some(snap.props.clone());
    }

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
            refresh_media_snapshot
        ])
        .plugin(tauri_plugin_log::Builder::default().build())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
