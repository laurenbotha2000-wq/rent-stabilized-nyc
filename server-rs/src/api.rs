//! HTTP API, same routes and semantics as server.py, served from memory.
//!
//!   GET /api/listings                 active listings
//!   GET /api/listings/neighborhoods   sorted neighborhoods with active listings
//!   GET /api/listings/history         every listing incl. DELISTED
//!   GET /api/listings/history/v2      history + per-listing snapshot array ("data")
//!   POST /api/sync                    sync now (at most once a minute)
//!   GET /healthz                      liveness + last sync (no API key needed)
//! Filters: neighborhood (comma-separated), minPrice, maxPrice, beds, baths, reason, page.
//! Only listings our own flags mark as stabilized are returned; all=1 includes the rest.
//! CORS is open so the desktop app (or any browser page) can call a deployed server;
//! the API key travels in a header, never a cookie.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use axum::extract::{Query, Request, State as AxState};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use serde::Serialize;
use serde_json::json;
use tokio::sync::Notify;

use crate::store::{Row, State, SyncStats};

const PAGE_SIZE: usize = 50;
const MIN_SYNC_GAP: Duration = Duration::from_secs(60);

#[derive(Default, Clone, Serialize)]
pub struct Health {
    pub last_sync_at: Option<String>,
    pub last_sync: Option<SyncStats>,
    pub last_error: Option<String>,
    pub syncing: bool,
    pub buildings: usize,
}

pub struct App {
    pub state: RwLock<Arc<State>>,
    pub health: RwLock<Health>,
    pub api_key: Option<String>,
    pub sync_now: Notify,
    pub last_sync_started: Mutex<Option<Instant>>,
}

impl App {
    pub fn snapshot(&self) -> Arc<State> {
        self.state.read().unwrap().clone()
    }
}

pub fn router(app: Arc<App>) -> Router {
    Router::new()
        .route("/api/listings", get(listings))
        .route("/api/listings/history", get(history))
        .route("/api/listings/history/v2", get(history_v2))
        .route("/api/listings/neighborhoods", get(neighborhoods))
        .route("/api/sync", post(sync_now))
        .fallback(|| async { error(StatusCode::NOT_FOUND, "not found") })
        .layer(middleware::from_fn_with_state(app.clone(), require_key))
        .route("/healthz", get(healthz))
        .route("/", get(|| async { static_file("text/html; charset=utf-8", include_str!("../../ui/index.html")) }))
        .route("/app.js", get(|| async { static_file("text/javascript", include_str!("../../ui/app.js")) }))
        .route("/style.css", get(|| async { static_file("text/css", include_str!("../../ui/style.css")) }))
        .layer(middleware::from_fn(cors))
        .with_state(app)
}

async fn cors(req: Request, next: Next) -> Response {
    let mut res = if req.method() == Method::OPTIONS {
        StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(req).await
    };
    let h = res.headers_mut();
    h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    h.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET, POST, OPTIONS"));
    h.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("x-api-key, content-type"));
    h.insert(header::ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("86400"));
    res
}

async fn sync_now(AxState(app): AxState<Arc<App>>) -> Response {
    let recent = app.last_sync_started.lock().unwrap().is_some_and(|t| t.elapsed() < MIN_SYNC_GAP);
    if recent || app.health.read().unwrap().syncing {
        return error(StatusCode::TOO_MANY_REQUESTS, "a sync ran less than a minute ago");
    }
    app.sync_now.notify_one();
    raw_json(StatusCode::ACCEPTED, json!({ "ok": true }).to_string())
}

/// The desktop app's UI, also served by the server so a browser can use it.
fn static_file(content_type: &'static str, body: &'static str) -> Response {
    let mut res = body.into_response();
    res.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    res
}

fn raw_json(status: StatusCode, body: String) -> Response {
    let mut res = (status, body).into_response();
    res.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    res
}

fn error(status: StatusCode, msg: &str) -> Response {
    raw_json(status, json!({ "error": msg }).to_string())
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn require_key(AxState(app): AxState<Arc<App>>, req: Request, next: Next) -> Response {
    if let Some(key) = &app.api_key {
        let given = req.headers().get("x-api-key").map(|v| v.as_bytes()).unwrap_or_default();
        if !ct_eq(given, key.as_bytes()) {
            return error(StatusCode::UNAUTHORIZED, "invalid or missing x-api-key");
        }
    }
    next.run(req).await
}

struct Filter {
    active_only: bool,
    flagged_only: bool,
    hoods: Option<Vec<String>>,
    min_price: Option<f64>,
    max_price: Option<f64>,
    beds: Option<f64>,
    baths: Option<f64>,
    reason: Option<String>,
    url: Option<String>,
    page: usize,
}

impl Filter {
    fn parse(q: &HashMap<String, String>, active_only: bool) -> Result<Self, String> {
        // like Python's parse_qs: blank values count as absent
        let get = |k: &str| q.get(k).map(|s| s.as_str()).filter(|s| !s.is_empty());
        let num = |k: &str| -> Result<Option<f64>, String> {
            get(k)
                .map(|v| v.trim().parse::<f64>().map_err(|_| format!("could not convert string to float: '{v}'")))
                .transpose()
        };
        let page = match get("page") {
            None => 1,
            Some(p) => p
                .trim()
                .parse::<i64>()
                .map_err(|_| format!("invalid literal for int() with base 10: '{p}'"))?
                .max(1) as usize,
        };
        Ok(Self {
            active_only,
            flagged_only: get("all") != Some("1"),
            hoods: get("neighborhood").map(|h| {
                h.split(',').map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).collect()
            }),
            min_price: num("minPrice")?,
            max_price: num("maxPrice")?,
            beds: num("beds")?,
            baths: num("baths")?,
            reason: get("reason").map(str::to_string),
            url: get("url").map(str::to_string),
            page,
        })
    }

    fn matches(&self, r: &Row) -> bool {
        // SQL semantics: a comparison with NULL never matches
        let ge = |v: Option<f64>, x: f64| v.is_some_and(|v| v >= x);
        let le = |v: Option<f64>, x: f64| v.is_some_and(|v| v <= x);
        let eq = |v: Option<f64>, x: f64| v.is_some_and(|v| v == x);
        (!self.active_only || r.active)
            && (!self.flagged_only || !r.reasons.is_empty())
            && self.hoods.as_ref().is_none_or(|h| r.neighborhood.as_ref().is_some_and(|n| h.contains(n)))
            && self.min_price.is_none_or(|x| ge(r.price, x))
            && self.max_price.is_none_or(|x| le(r.price, x))
            && self.beds.is_none_or(|x| eq(r.beds, x))
            && self.baths.is_none_or(|x| eq(r.baths, x))
            && self.reason.as_ref().is_none_or(|x| r.reasons.contains(x))
            && self.url.as_ref().is_none_or(|x| &r.url == x)
    }
}

fn page_response(app: &App, q: &HashMap<String, String>, active_only: bool, v2: bool) -> Response {
    let f = match Filter::parse(q, active_only) {
        Ok(f) => f,
        Err(e) => return error(StatusCode::BAD_REQUEST, &e),
    };
    let state = app.snapshot();
    let skip = (f.page - 1) * PAGE_SIZE;
    let mut total = 0;
    let mut body = String::with_capacity(64 * 1024);
    body.push_str(r#"{"data":["#);
    for r in state.rows.iter().filter(|r| f.matches(r)) {
        if total >= skip && total < skip + PAGE_SIZE {
            if total > skip {
                body.push(',');
            }
            body.push_str(if v2 { r.json_v2.get() } else { r.json.get() });
        }
        total += 1;
    }
    let pages = total.div_ceil(PAGE_SIZE);
    body.push_str(&format!(
        r#"],"pagination":{{"page":{},"limit":{PAGE_SIZE},"total":{total},"pages":{pages}}}}}"#,
        f.page
    ));
    raw_json(StatusCode::OK, body)
}

async fn listings(AxState(app): AxState<Arc<App>>, Query(q): Query<HashMap<String, String>>) -> Response {
    page_response(&app, &q, true, false)
}

async fn history(AxState(app): AxState<Arc<App>>, Query(q): Query<HashMap<String, String>>) -> Response {
    page_response(&app, &q, false, false)
}

async fn history_v2(AxState(app): AxState<Arc<App>>, Query(q): Query<HashMap<String, String>>) -> Response {
    page_response(&app, &q, false, true)
}

async fn neighborhoods(AxState(app): AxState<Arc<App>>) -> Response {
    raw_json(StatusCode::OK, json!({ "data": app.snapshot().neighborhoods }).to_string())
}

async fn healthz(AxState(app): AxState<Arc<App>>) -> Response {
    let health = app.health.read().unwrap().clone();
    let listings = app.snapshot().rows.len();
    let ok = listings > 0 || health.last_sync.is_some();
    let status = if ok { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE };
    raw_json(status, json!({ "ok": ok, "listings": listings, "health": health }).to_string())
}
