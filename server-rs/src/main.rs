//! Always-on rent-stabilized listings server.
//!
//!   reasier-server              run the server
//!   reasier-server export DIR   sync once, write DIR/data.json (hosted site;
//!                               descriptions omitted unless EXPORT_DESCRIPTIONS=1)
//!
//! Environment:
//!   PORT                 default 8787
//!   BIND_ADDR            default 0.0.0.0
//!   DB_PATH              default reasier.db
//!   RGB_PATH             default data/rgb_buildings.json (written by rgb.py)
//!   SYNC_INTERVAL_SECS   default 3600 (minimum 300)
//!   API_KEY              if set, required as the x-api-key header

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use reasier::{Config, RgbSource};

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| default.to_string())
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("export") {
        let out = args.get(1).context("usage: reasier-server export DIR")?;
        let db = PathBuf::from(env_or("DB_PATH", "reasier.db"));
        let rgb = RgbSource::Path(PathBuf::from(env_or("RGB_PATH", "data/rgb_buildings.json")));
        let with_descriptions = env_or("EXPORT_DESCRIPTIONS", "0") == "1";
        return reasier::export(&db, rgb, std::path::Path::new(out), with_descriptions).await;
    }

    let ip: IpAddr = env_or("BIND_ADDR", "0.0.0.0").parse().context("BIND_ADDR")?;
    let port: u16 = env_or("PORT", "8787").parse().context("PORT")?;
    let every: u64 = env_or("SYNC_INTERVAL_SECS", "3600").parse().context("SYNC_INTERVAL_SECS")?;
    let config = Config {
        bind: SocketAddr::new(ip, port),
        db_path: PathBuf::from(env_or("DB_PATH", "reasier.db")),
        rgb: RgbSource::Path(PathBuf::from(env_or("RGB_PATH", "data/rgb_buildings.json"))),
        sync_every: Duration::from_secs(every.max(300)),
        api_key: std::env::var("API_KEY").ok().filter(|k| !k.is_empty()),
    };
    reasier::run(config, reasier::shutdown_signal(), |_| {}).await?;
    reasier::log!("shut down");
    Ok(())
}
