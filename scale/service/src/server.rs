//! Local API for the display (127.0.0.1 only).
//!
//! * `GET  /api/health`, `GET /api/state`, `GET /api/ws` (snapshot stream)
//! * `GET  /api/rfid/last` — latest tag read, for registration
//! * `POST /api/admin/login|logout`, `GET /api/admin/carriers`,
//!   `POST /api/admin/rfid` — RFID registration through the LabourLink
//!   server's own login, permissions and carrier validation
//! * `/api/sim/*` — simulation controls; 404 unless in simulation mode
//!
//! Requests whose Host header isn't loopback are refused (DNS-rebinding
//! guard), and CORS only admits the Tauri webview and the Vite dev server.

use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderValue, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::watch;
use tower_http::cors::{AllowOrigin, Any, CorsLayer};

use crate::app::{App, Wake};
use crate::backend::BackendError;

#[derive(Clone)]
struct Ctx {
    app: Arc<App>,
    snapshots: watch::Receiver<Arc<String>>,
}

type ApiResult = Result<Json<Value>, (StatusCode, Json<Value>)>;

fn err(status: StatusCode, message: impl Into<String>) -> (StatusCode, Json<Value>) {
    (status, Json(json!({ "error": message.into() })))
}

fn backend_err(e: BackendError) -> (StatusCode, Json<Value>) {
    match e {
        BackendError::Offline(m) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": format!("LabourLink server unreachable: {m}") })),
        ),
        BackendError::Http { status, message, errors } => (
            StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY),
            Json(json!({ "error": message, "errors": errors })),
        ),
    }
}

pub fn router(app: Arc<App>, snapshots: watch::Receiver<Arc<String>>) -> Router {
    let origins = [
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
    ]
    .iter()
    .map(|o| HeaderValue::from_static(o))
    .collect::<Vec<_>>();
    let cors = CorsLayer::new().allow_origin(AllowOrigin::list(origins)).allow_methods(Any).allow_headers(Any);
    let ctx = Ctx { app, snapshots };
    Router::new()
        .route("/api/health", get(health))
        .route("/api/state", get(state))
        .route("/api/ws", get(ws))
        .route("/api/rfid/last", get(rfid_last))
        .route("/api/admin/login", post(admin_login))
        .route("/api/admin/logout", post(admin_logout))
        .route("/api/admin/carriers", get(admin_carriers))
        .route("/api/admin/rfid", post(admin_rfid))
        .route("/api/sim/world", get(sim_world))
        .route("/api/sim/place", post(sim_place))
        .route("/api/sim/remove", post(sim_remove))
        .route("/api/sim/tag", post(sim_tag))
        .route("/api/sim/flags", post(sim_flags))
        .route("/api/sim/claim", post(sim_claim))
        .route("/api/sim/advance", post(sim_advance))
        .layer(cors)
        .layer(middleware::from_fn(loopback_host_only))
        .with_state(ctx)
}

async fn loopback_host_only(req: Request<Body>, next: Next) -> Response {
    let host = req.headers().get("host").and_then(|h| h.to_str().ok()).unwrap_or("");
    let name = host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host);
    if !matches!(name, "127.0.0.1" | "localhost" | "[::1]") {
        return (StatusCode::FORBIDDEN, "loopback only").into_response();
    }
    next.run(req).await
}

async fn health(State(c): State<Ctx>) -> Json<Value> {
    Json(json!({ "ok": true, "mode": c.app.mode().as_str() }))
}

async fn state(State(c): State<Ctx>) -> Json<Value> {
    Json(c.app.snapshot())
}

async fn ws(State(c): State<Ctx>, upgrade: WebSocketUpgrade) -> Response {
    upgrade.on_upgrade(move |socket| stream(socket, c.snapshots))
}

async fn stream(mut socket: WebSocket, mut rx: watch::Receiver<Arc<String>>) {
    let first = rx.borrow_and_update().clone();
    if socket.send(Message::Text((*first).clone())).await.is_err() {
        return;
    }
    loop {
        tokio::select! {
            changed = rx.changed() => {
                if changed.is_err() { return; }
                let json = rx.borrow_and_update().clone();
                if socket.send(Message::Text((*json).clone())).await.is_err() { return; }
            }
            msg = socket.recv() => {
                match msg { Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return, _ => {} }
            }
        }
    }
}

async fn rfid_last(State(c): State<Ctx>) -> Json<Value> {
    Json(c.app.last_tag())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    tokio::task::spawn_blocking(f).await.expect("blocking task panicked")
}

#[derive(Deserialize)]
struct LoginBody {
    email: String,
    pin: String,
}

async fn admin_login(State(c): State<Ctx>, Json(b): Json<LoginBody>) -> ApiResult {
    let app = c.app.clone();
    let s = blocking(move || app.backend.admin_login(&b.email, &b.pin)).await.map_err(backend_err)?;
    // Tag assignment is Administrator-only on the server (PATCH /api/carriers/:id);
    // refuse other roles up front instead of failing at save time.
    if s.role != "Administrator" {
        return Err(err(
            StatusCode::FORBIDDEN,
            format!("{} is a {}. Only LabourLink Administrators can register RFID tags.", s.name, s.role),
        ));
    }
    let name = s.name.clone();
    let token = c.app.admin_put(s);
    Ok(Json(json!({ "token": token, "name": name })))
}

fn admin_token(h: &HeaderMap) -> Option<String> {
    h.get("x-admin-token").and_then(|v| v.to_str().ok()).map(str::to_string)
}

async fn admin_logout(State(c): State<Ctx>, h: HeaderMap) -> Json<Value> {
    if let Some(t) = admin_token(&h) {
        c.app.admin_drop(&t);
    }
    Json(json!({ "ok": true }))
}

#[derive(Deserialize)]
struct SearchQuery {
    #[serde(default)]
    search: String,
}

async fn admin_carriers(State(c): State<Ctx>, h: HeaderMap, Query(q): Query<SearchQuery>) -> ApiResult {
    let s = admin_token(&h)
        .and_then(|t| c.app.admin_get(&t))
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "Admin session expired — log in again"))?;
    let app = c.app.clone();
    let list = blocking(move || app.backend.admin_carriers(&s, &q.search)).await.map_err(backend_err)?;
    Ok(Json(json!({ "carriers": list })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RfidBody {
    carrier_id: String,
    rfid_tag: Option<String>,
}

async fn admin_rfid(State(c): State<Ctx>, h: HeaderMap, Json(b): Json<RfidBody>) -> ApiResult {
    let s = admin_token(&h)
        .and_then(|t| c.app.admin_get(&t))
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "Admin session expired — log in again"))?;
    let app = c.app.clone();
    let carrier = blocking(move || app.backend.admin_set_rfid(&s, &b.carrier_id, b.rfid_tag.as_deref()))
        .await
        .map_err(backend_err)?;
    // Pick the new mapping up immediately for weighing.
    c.app.wake(Wake::RefreshCarriers);
    Ok(Json(json!({ "carrier": carrier })))
}

// ---------------------------------------------------------------------------
// Simulation controls

type SimParts = (Arc<crate::sim::SimServer>, Arc<crate::sim::SimRig>);

fn sim(c: &Ctx) -> Result<SimParts, (StatusCode, Json<Value>)> {
    c.app.sim.clone().ok_or_else(|| err(StatusCode::NOT_FOUND, "simulation mode is off"))
}

async fn sim_world(State(c): State<Ctx>) -> ApiResult {
    let (server, rig) = sim(&c)?;
    let mut w = server.world();
    w["rig"] = serde_json::to_value(rig.view()).unwrap();
    Ok(Json(w))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlaceBody {
    tag: Option<String>,
    gross_kg: f64,
}

async fn sim_place(State(c): State<Ctx>, Json(b): Json<PlaceBody>) -> ApiResult {
    let (_, rig) = sim(&c)?;
    if !(0.0..=2000.0).contains(&b.gross_kg) {
        return Err(err(StatusCode::BAD_REQUEST, "grossKg out of range"));
    }
    rig.place(b.tag, crate::backend::kg_to_g(b.gross_kg));
    Ok(Json(json!({ "ok": true })))
}

async fn sim_remove(State(c): State<Ctx>) -> ApiResult {
    sim(&c)?.1.remove();
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct TagBody {
    tag: String,
}

async fn sim_tag(State(c): State<Ctx>, Json(b): Json<TagBody>) -> ApiResult {
    sim(&c)?.1.read_tag_once(b.tag);
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FlagsBody {
    wobble: Option<bool>,
    scale_offline: Option<bool>,
    rfid_offline: Option<bool>,
    rfid_repeat: Option<bool>,
    indicator_net: Option<bool>,
    overload: Option<bool>,
    server_online: Option<bool>,
}

async fn sim_flags(State(c): State<Ctx>, Json(b): Json<FlagsBody>) -> ApiResult {
    let (server, rig) = sim(&c)?;
    rig.set_flags(|f| {
        if let Some(v) = b.wobble {
            f.wobble = v;
        }
        if let Some(v) = b.scale_offline {
            f.scale_offline = v;
        }
        if let Some(v) = b.rfid_offline {
            f.rfid_offline = v;
        }
        if let Some(v) = b.rfid_repeat {
            f.rfid_repeat = v;
        }
        if let Some(v) = b.indicator_net {
            f.indicator_net = v;
        }
        if let Some(v) = b.overload {
            f.overload = v;
        }
    });
    if let Some(v) = b.server_online {
        server.set_online(v);
        c.app.wake(Wake::Upload);
    }
    c.app.publish();
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaimBody {
    employee_id: String,
    /// "beforeWeighing" (needs weighingId), "now" or "minutesAgo" (need carrierId).
    timing: String,
    weighing_id: Option<String>,
    carrier_id: Option<String>,
    #[serde(default)]
    minutes_ago: i64,
    #[serde(default = "yes")]
    clock_trusted: bool,
}

fn yes() -> bool {
    true
}

async fn sim_claim(State(c): State<Ctx>, Json(b): Json<ClaimBody>) -> ApiResult {
    let (server, _) = sim(&c)?;
    let bad = |m: &str| err(StatusCode::BAD_REQUEST, m);
    let timing = match b.timing.as_str() {
        "beforeWeighing" => crate::sim::ScanTiming::BeforeWeighing(b.weighing_id.ok_or_else(|| bad("weighingId required"))?),
        "now" => crate::sim::ScanTiming::Now(b.carrier_id.ok_or_else(|| bad("carrierId required"))?),
        "minutesAgo" => crate::sim::ScanTiming::MinutesAgo(b.carrier_id.ok_or_else(|| bad("carrierId required"))?, b.minutes_ago),
        _ => return Err(bad("timing must be beforeWeighing, now or minutesAgo")),
    };
    server
        .add_claim(&b.employee_id, timing, b.clock_trusted)
        .map_err(|e| err(StatusCode::BAD_REQUEST, e))?;
    c.app.wake(Wake::Upload);
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct AdvanceBody {
    hours: f64,
}

async fn sim_advance(State(c): State<Ctx>, Json(b): Json<AdvanceBody>) -> ApiResult {
    let (server, _) = sim(&c)?;
    if !(0.0..=72.0).contains(&b.hours) {
        return Err(err(StatusCode::BAD_REQUEST, "hours must be 0–72"));
    }
    // One-off: applies the 24-hour rule as if this much time had passed.
    server.expire_as_if((b.hours * 3_600_000.0) as i64);
    c.app.wake(Wake::Upload);
    Ok(Json(json!({ "ok": true })))
}
