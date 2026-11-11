//! Local API for the display (127.0.0.1 only).
//!
//! * `GET  /api/health`, `GET /api/state`, `GET /api/ws` (snapshot stream)
//! * `GET  /api/rfid/last` — latest tag read
//! * `POST /api/session/login|logout` — a LabourLink user (any role) signs in
//!   with their own email and PIN, through the server's own login
//! * `/api/register/*` — Register Bins: start/stop (weighing pauses while it
//!   is open), bin lookup, the measured tag's current bin, confirm, remove a
//!   tag. Every change is checked again and audited by the server
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

use crate::app::{App, ConfirmChoice, RegisterError};
use crate::backend::{BackendError, Expected};

#[derive(Clone)]
struct Ctx {
    app: Arc<App>,
    snapshots: watch::Receiver<Arc<String>>,
}

type ApiResult = Result<Json<Value>, (StatusCode, Json<Value>)>;

fn err(status: StatusCode, message: impl Into<String>) -> (StatusCode, Json<Value>) {
    (status, Json(json!({ "error": message.into() })))
}

/// Passes a server refusal through with its data (code, the bin that holds
/// a tag, the bin's current tag and tare), so the display can explain it.
fn backend_err(e: BackendError) -> (StatusCode, Json<Value>) {
    match e {
        BackendError::Offline(m) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": format!("LabourLink server unreachable: {m}") })),
        ),
        BackendError::Http {
            status,
            message,
            errors,
            code,
            body,
        } => {
            let mut out = if body.is_object() { body } else { json!({}) };
            out["error"] = json!(message);
            out["errors"] = json!(errors);
            out["code"] = json!(code);
            (StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY), Json(out))
        }
    }
}

fn register_err(e: RegisterError) -> (StatusCode, Json<Value>) {
    match e {
        RegisterError::Session => err(StatusCode::UNAUTHORIZED, "Signed out. Sign in again."),
        RegisterError::Refused(m) => (StatusCode::CONFLICT, Json(json!({ "error": m, "code": "stationRefused" }))),
        RegisterError::Server(e) => backend_err(e),
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
        .route("/api/session/login", post(session_login))
        .route("/api/session/logout", post(session_logout))
        .route("/api/register/start", post(register_start))
        .route("/api/register/stop", post(register_stop))
        .route("/api/register/bins", get(register_bins))
        .route("/api/register/tag-owner", get(register_tag_owner))
        .route("/api/register/confirm", post(register_confirm))
        .route("/api/register/remove-tag", post(register_remove_tag))
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

/// Any LabourLink user can sign in to register bins; the server's own login
/// checks the email and PIN.
async fn session_login(State(c): State<Ctx>, Json(b): Json<LoginBody>) -> ApiResult {
    let app = c.app.clone();
    let s = blocking(move || app.backend.user_login(&b.email, &b.pin)).await.map_err(backend_err)?;
    let (name, role) = (s.name.clone(), s.role.clone());
    let token = c.app.session_put(s);
    Ok(Json(json!({ "token": token, "name": name, "role": role })))
}

fn session_token(h: &HeaderMap) -> Result<String, (StatusCode, Json<Value>)> {
    h.get("x-session-token")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "Signed out. Sign in again."))
}

async fn session_logout(State(c): State<Ctx>, h: HeaderMap) -> Json<Value> {
    if let Ok(t) = session_token(&h) {
        let app = c.app.clone();
        blocking(move || app.session_drop(&t)).await;
    }
    Json(json!({ "ok": true }))
}

async fn register_start(State(c): State<Ctx>, h: HeaderMap) -> ApiResult {
    let t = session_token(&h)?;
    c.app.start_registration(&t).map_err(register_err)?;
    Ok(Json(json!({ "ok": true })))
}

async fn register_stop(State(c): State<Ctx>, h: HeaderMap) -> ApiResult {
    session_token(&h)?;
    c.app.stop_registration();
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct BinQuery {
    #[serde(default)]
    q: String,
}

async fn register_bins(State(c): State<Ctx>, h: HeaderMap, Query(q): Query<BinQuery>) -> ApiResult {
    let t = session_token(&h)?;
    let app = c.app.clone();
    let bins = blocking(move || app.find_bins(&t, &q.q)).await.map_err(register_err)?;
    Ok(Json(json!({ "bins": bins })))
}

async fn register_tag_owner(State(c): State<Ctx>, h: HeaderMap) -> ApiResult {
    let t = session_token(&h)?;
    let app = c.app.clone();
    Ok(Json(blocking(move || app.proposal_tag_owner(&t)).await.map_err(register_err)?))
}

async fn register_confirm(State(c): State<Ctx>, h: HeaderMap, Json(b): Json<ConfirmChoice>) -> ApiResult {
    let t = session_token(&h)?;
    let app = c.app.clone();
    let outcome = blocking(move || app.confirm_registration(&t, b)).await.map_err(register_err)?;
    Ok(Json(json!(outcome)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveTagBody {
    carrier_id: String,
    expected: Expected,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    confirm: bool,
}

async fn register_remove_tag(State(c): State<Ctx>, h: HeaderMap, Json(b): Json<RemoveTagBody>) -> ApiResult {
    let t = session_token(&h)?;
    if !b.confirm {
        return Err(err(StatusCode::BAD_REQUEST, "Confirm removing the tag."));
    }
    let app = c.app.clone();
    let outcome = blocking(move || app.remove_tag(&t, b.carrier_id, b.expected, b.reason)).await.map_err(register_err)?;
    Ok(Json(json!(outcome)))
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
    /// The test server's station credit switch (off = trial).
    credits_enabled: Option<bool>,
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
        c.app.wake(crate::app::Wake::Upload);
    }
    if let Some(v) = b.credits_enabled {
        server.set_credits_enabled(v);
        c.app.wake(crate::app::Wake::RefreshCarriers);
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
    c.app.wake(crate::app::Wake::Upload);
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
    c.app.wake(crate::app::Wake::Upload);
    Ok(Json(json!({ "ok": true })))
}
