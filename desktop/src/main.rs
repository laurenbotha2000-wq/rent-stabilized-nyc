//! Desktop app: runs the listings service privately on 127.0.0.1 (random port)
//! and shows the shared web UI. The UI can instead point at a deployed server.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::mpsc;
use std::sync::OnceLock;
use std::time::Duration;

use reasier::{Config, RgbSource};
use tauri::Manager;

static RGB: &[u8] = include_bytes!("../../data/rgb_buildings.json");
static LOCAL_URL: OnceLock<String> = OnceLock::new();

/// Base URL of the built-in server, or None if it failed to start.
#[tauri::command]
fn local_server_url() -> Option<String> {
    LOCAL_URL.get().cloned()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let config = Config {
                bind: SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
                db_path: dir.join("reasier.db"),
                rgb: RgbSource::Bytes(RGB),
                sync_every: Duration::from_secs(3600),
                api_key: None,
            };
            let (tx, rx) = mpsc::channel();
            std::thread::spawn(move || {
                let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
                let served = rt.block_on(reasier::run(config, std::future::pending(), |r| {
                    let _ = tx.send(format!("http://{}", r.addr));
                }));
                if let Err(e) = served {
                    reasier::log!("built-in server failed: {e:#}");
                }
            });
            if let Ok(url) = rx.recv_timeout(Duration::from_secs(15)) {
                let _ = LOCAL_URL.set(url);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![local_server_url])
        .run(tauri::generate_context!())
        .expect("error while running the desktop app");
}
