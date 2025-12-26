#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Arc;

use gsmtc::{ManagerEvent, SessionManager, SessionUpdateEvent};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc::UnboundedReceiver, Mutex};

use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSessionManager,
    GlobalSystemMediaTransportControlsSession,
};
use windows::Media::MediaPlaybackAutoRepeatMode;

#[derive(Debug, serde::Deserialize)]
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
    let mgr = op.get().map_err(|e| format!("RequestAsync get failed: {e:?}"))?;

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
        let _ = op
            .get()
            .map_err(|e| format!("Shuffle get failed: {e:?}"))?;
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
        let _ = op
            .get()
            .map_err(|e| format!("Repeat get failed: {e:?}"))?;
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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct MediaPropsDto {
    title: String,
    artist: String,
    album_title: Option<String>,
    album_image: Option<String>, // base64 PNG/JPEG
}

#[derive(Debug, Default)]
struct MediaState {
    props: Mutex<Option<MediaPropsDto>>,
}

#[tauri::command]
async fn get_current_media(
    state: State<'_, Arc<MediaState>>,
) -> Result<Option<MediaPropsDto>, String> {
    Ok(state.props.lock().await.clone())
}

#[tauri::command]
async fn start_media_listener(
    app_handle: AppHandle,
    state: State<'_, Arc<MediaState>>,
) -> Result<(), String> {
    let state = state.inner().clone();

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
                            .and_then(|img| Some(img.data)) // Vec<u8> -> Option<Vec<u8>>
                            .map(|bytes| base64::encode(bytes));

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
                            let mut guard = state.props.lock().await;
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
            let _res = op
                .get()
                .map_err(|e| format!("Toggle get failed: {e:?}"))?;
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


fn main() {
    tauri::Builder::default()
        .manage(Arc::new(MediaState::default()))
        .invoke_handler(tauri::generate_handler![
            get_current_media,
            start_media_listener,
            control_media,
            set_shuffle,
            set_repeat,
        ])
        .plugin(tauri_plugin_log::Builder::default().build())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
