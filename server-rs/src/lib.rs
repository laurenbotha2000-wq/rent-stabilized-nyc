//! Rent-stabilized listings service: syncs Reasier's public list on a timer
//! (applying our own RGB-based flags), keeps history in SQLite, and serves the
//! API from an in-memory snapshot. Used by the headless server (main.rs) and
//! embedded in the desktop app.

pub mod api;
pub mod features;
pub mod flags;
pub mod geocode;
pub mod source;
pub mod store;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use tokio::sync::Notify;

use api::{App, Health};
use flags::{Building, BuildingIndex};

#[macro_export]
macro_rules! log {
    ($($arg:tt)*) => { eprintln!("{} {}", $crate::store::now_iso(), format!($($arg)*)) };
}

pub enum RgbSource {
    Path(PathBuf),
    Bytes(&'static [u8]),
}

pub struct Config {
    pub bind: SocketAddr,
    pub db_path: PathBuf,
    pub rgb: RgbSource,
    pub sync_every: Duration,
    pub api_key: Option<String>,
}

pub struct Running {
    pub addr: SocketAddr,
    pub app: Arc<App>,
}

/// Load data, start the sync loop, bind the HTTP API and serve until
/// `shutdown` resolves. `on_ready` gets the bound address (port 0 picks one).
pub async fn run(
    config: Config,
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
    on_ready: impl FnOnce(&Running),
) -> Result<()> {
    let rgb = match &config.rgb {
        RgbSource::Path(p) => {
            std::fs::read(p).with_context(|| format!("{} missing; run: python3 rgb.py", p.display()))?
        }
        RgbSource::Bytes(b) => b.to_vec(),
    };
    let index = Arc::new(BuildingIndex::new(serde_json::from_slice::<Vec<Building>>(&rgb)?));
    log!("loaded {} RGB building rows", index.len());

    let state = {
        let con = store::open(&config.db_path)?;
        store::load_state(&con)?
    };
    log!("serving {} listings from {}", state.rows.len(), config.db_path.display());
    if config.api_key.is_none() && !config.bind.ip().is_loopback() {
        log!("warning: API_KEY not set; the API is open to anyone who can reach it");
    }

    let app = Arc::new(App {
        state: RwLock::new(Arc::new(state)),
        health: RwLock::new(Health { buildings: index.len(), ..Default::default() }),
        api_key: config.api_key,
        sync_now: Notify::new(),
        last_sync_started: Mutex::new(None),
    });
    tokio::spawn(sync_loop(app.clone(), index, config.db_path, config.sync_every));

    let listener = tokio::net::TcpListener::bind(config.bind).await?;
    let running = Running { addr: listener.local_addr()?, app: app.clone() };
    log!("listening on http://{}", running.addr);
    on_ready(&running);
    axum::serve(listener, api::router(app)).with_graceful_shutdown(shutdown).await?;
    Ok(())
}

async fn sync_loop(app: Arc<App>, index: Arc<BuildingIndex>, db_path: PathBuf, every: Duration) {
    let client = reqwest::Client::builder()
        .user_agent(source::USER_AGENT)
        .timeout(Duration::from_secs(60))
        .build()
        .expect("http client");
    loop {
        let started = Instant::now();
        *app.last_sync_started.lock().unwrap() = Some(started);
        app.health.write().unwrap().syncing = true;
        let result = sync_once(&app, &client, &index, &db_path).await;
        {
            let mut h = app.health.write().unwrap();
            h.syncing = false;
            match result {
                Ok(stats) => {
                    log!("sync ok in {:?}: {}", started.elapsed(), serde_json::to_string(&stats).unwrap());
                    h.last_sync_at = Some(store::now_iso());
                    h.last_sync = Some(stats);
                    h.last_error = None;
                }
                // keep serving the previous snapshot; try again next tick
                Err(e) => {
                    log!("sync failed: {e:#}");
                    h.last_error = Some(format!("{e:#}"));
                }
            }
        }
        tokio::select! {
            _ = tokio::time::sleep(every) => {}
            _ = app.sync_now.notified() => {}
        }
    }
}

async fn sync_once(
    app: &Arc<App>,
    client: &reqwest::Client,
    index: &Arc<BuildingIndex>,
    db_path: &PathBuf,
) -> Result<store::SyncStats> {
    let listings = source::dedupe(source::fetch_listings(client).await?);
    let (index, path) = (index.clone(), db_path.clone());
    let stats = tokio::task::spawn_blocking(move || -> Result<_> {
        store::sync(&mut store::open(&path)?, &listings, &index, &store::now_iso())
    })
    .await??;
    match geocode::fill_missing(client, db_path).await {
        Ok(0) => {}
        Ok(n) => log!("geocoded {n} new addresses"),
        Err(e) => log!("geocoding failed (will retry next sync): {e:#}"),
    }
    let path = db_path.clone();
    let state = tokio::task::spawn_blocking(move || store::load_state(&store::open(&path)?)).await??;
    *app.state.write().unwrap() = Arc::new(state);
    Ok(stats)
}

/// One-shot sync for hosted use: sync `db_path`, geocode new addresses, then
/// write `out_dir/data.json` (every listing, including delisted, with its
/// history). Listing descriptions are left out unless `with_descriptions`.
/// If the fetch fails the existing data is still exported, so the site keeps
/// working; the error is returned after writing.
pub async fn export(
    db_path: &std::path::Path,
    rgb: RgbSource,
    out_dir: &std::path::Path,
    with_descriptions: bool,
) -> Result<()> {
    let rgb = match rgb {
        RgbSource::Path(p) => std::fs::read(&p).with_context(|| format!("{} missing", p.display()))?,
        RgbSource::Bytes(b) => b.to_vec(),
    };
    let index = BuildingIndex::new(serde_json::from_slice::<Vec<Building>>(&rgb)?);
    let client = reqwest::Client::builder()
        .user_agent(source::USER_AGENT)
        .timeout(Duration::from_secs(60))
        .build()?;
    let fetched = source::fetch_listings(&client).await.map(source::dedupe);

    let now = store::now_iso();
    let (stats, error) = match &fetched {
        Ok(listings) => (Some(store::sync(&mut store::open(db_path)?, listings, &index, &now)?), None),
        Err(e) => (None, Some(format!("{e:#}"))),
    };
    match geocode::fill_missing(&client, db_path).await {
        Ok(0) => {}
        Ok(n) => log!("geocoded {n} new addresses"),
        Err(e) => log!("geocoding failed (will retry next run): {e:#}"),
    }
    let con = store::open(db_path)?;
    // fold the WAL back into the file so the saved copy is self-contained
    con.pragma_update(None, "journal_mode", "DELETE")?;
    let state = store::load_state(&con)?;

    let mut body = String::with_capacity(4 << 20);
    body.push_str(&format!(
        r#"{{"generated_at":{},"last_sync":{},"last_error":{},"listings":["#,
        serde_json::to_string(&now)?,
        serde_json::to_string(&stats)?,
        serde_json::to_string(&error)?,
    ));
    for (i, r) in state.rows.iter().enumerate() {
        if i > 0 {
            body.push(',');
        }
        if with_descriptions {
            body.push_str(r.json_v2.get());
        } else {
            let mut v: serde_json::Map<String, serde_json::Value> = serde_json::from_str(r.json_v2.get())?;
            v.shift_remove("description");
            body.push_str(&serde_json::to_string(&v)?);
        }
    }
    body.push_str("]}");
    std::fs::create_dir_all(out_dir)?;
    std::fs::write(out_dir.join("data.json"), body)?;
    log!("exported {} listings to {}", state.rows.len(), out_dir.join("data.json").display());
    match (stats, error) {
        (Some(s), _) => {
            log!("sync ok: {}", serde_json::to_string(&s)?);
            Ok(())
        }
        (None, e) => Err(anyhow::anyhow!("sync failed (exported previous data): {}", e.unwrap_or_default())),
    }
}

/// Resolves on Ctrl-C or SIGTERM.
pub async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c().await.ok();
    };
    #[cfg(unix)]
    let term = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = term => {} }
}
