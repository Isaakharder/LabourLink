//! Service core: owns the state machine, the store and the backend, turns
//! hardware input into weighings, runs the outbox/assignment uploader and
//! publishes a JSON snapshot for the display.

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::watch;

use crate::backend::{
    g_to_kg, normalize_status, Backend, BackendError, Expected, Measured, RegistrationOutcome, RegistrationRequest, RemoveTagRequest, UserSession,
};
use crate::config::{Config, Mode};
use crate::machine::{CarrierInfo, Machine, Phase, RecordDraft};
use crate::registration::{RegPhase, Registration};
use crate::scale_proto::Reading;
use crate::sim::{SimRig, SimServer};
use crate::store::{Assignment, Store, Weighing};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinkStatus {
    /// connected | disconnected | simulated | online | offline
    pub state: String,
    pub detail: String,
}

impl LinkStatus {
    pub fn new(state: &str, detail: impl Into<String>) -> Self {
        Self {
            state: state.into(),
            detail: detail.into(),
        }
    }
}

pub enum LinkKind {
    Scale,
    Rfid,
}

pub enum Input {
    Reading(Reading),
    Tag(String),
    Link(LinkKind, LinkStatus),
}

pub enum Wake {
    Upload,
    RefreshCarriers,
}

struct Engine {
    machine: Machine,
    carriers_by_tag: HashMap<String, CarrierInfo>,
    carrier_count: usize,
    scale_link: LinkStatus,
    rfid_link: LinkStatus,
    last_recorded_id: Option<String>,
    /// Register Bins is open. While it is, every reading and tag goes to the
    /// registration machine and none to the weighing machine, so
    /// registration can never record a weighing.
    registering: Option<RegisterSession>,
}

struct RegisterSession {
    reg: Registration,
    /// The local session token of the person who opened Register Bins.
    token: String,
    person: String,
}

/// What the person chose for the measured bin (POST /api/register/confirm).
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmChoice {
    pub carrier_id: String,
    pub expected: Expected,
    pub empty_confirmed: bool,
    #[serde(default)]
    pub confirm_overwrite: bool,
    #[serde(default)]
    pub move_from_carrier_id: Option<String>,
}

#[derive(Debug)]
pub enum RegisterError {
    /// Not signed in, or the session ran out.
    Session,
    /// The station refused before asking the server (no measurement, the
    /// weight changed, the bin isn't confirmed empty).
    Refused(String),
    Server(BackendError),
}

struct ServerLink {
    status: LinkStatus,
    last_ok_at: Option<String>,
}

pub struct App {
    pub cfg: Config,
    pub backend: Arc<dyn Backend>,
    pub sim: Option<(Arc<SimServer>, Arc<SimRig>)>,
    store: Mutex<Store>,
    engine: Mutex<Engine>,
    server: Mutex<ServerLink>,
    recent: Mutex<Vec<Weighing>>,
    counts: Mutex<(i64, i64, i64)>,
    snapshot_tx: watch::Sender<Arc<String>>,
    wake_tx: Mutex<Sender<Wake>>,
    sessions: Mutex<HashMap<String, (UserSession, Instant)>>,
    /// The station's own credits switch on the server (None until known).
    /// While it is false every weighing is a trial.
    credits_enabled: Mutex<Option<bool>>,
    epoch: Instant,
    /// Added to the monotonic clock; only tests move it.
    clock_skip_ms: std::sync::atomic::AtomicU64,
}

/// A signed-in person is signed out after this long without using the station.
const SESSION_IDLE: Duration = Duration::from_secs(15 * 60);

/// How far back the station keeps re-checking weighings with the server.
/// Longer than the 24-hour pending window, so every outcome is seen.
const VERIFY_WINDOW_HOURS: i64 = 48;

/// The LabourLink link in the test modes, where the "server" is the
/// in-process test server and nothing goes over the network.
fn test_server_status(mode: Mode) -> Option<LinkStatus> {
    match mode {
        Mode::Simulation => Some(LinkStatus::new("simulated", "In-process simulator — no network")),
        Mode::HardwareTest => Some(LinkStatus::new(
            "simulated",
            "Hardware test: in-process test server, no network. Nothing is sent to LabourLink",
        )),
        Mode::Live => None,
    }
}

pub fn utc_now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

impl App {
    pub fn new(
        cfg: Config,
        store: Store,
        backend: Arc<dyn Backend>,
        sim: Option<(Arc<SimServer>, Arc<SimRig>)>,
    ) -> (Arc<App>, Receiver<Wake>, watch::Receiver<Arc<String>>) {
        let (wake_tx, wake_rx) = std::sync::mpsc::channel();
        let (snapshot_tx, snapshot_rx) = watch::channel(Arc::new(String::from("{}")));
        let simulated = sim.is_some();
        let test_server = test_server_status(cfg.mode);
        let link = |what: &str| {
            if simulated {
                LinkStatus::new("simulated", format!("Simulated {what}"))
            } else {
                LinkStatus::new("disconnected", "Not opened yet")
            }
        };
        let engine = Engine {
            machine: Machine::new(cfg.params()),
            carriers_by_tag: HashMap::new(),
            carrier_count: 0,
            scale_link: link("indicator"),
            rfid_link: link("RFID reader"),
            last_recorded_id: None,
            registering: None,
        };
        let server = ServerLink {
            status: if let Some(s) = test_server.clone() {
                s
            } else {
                LinkStatus::new("offline", "Not contacted yet")
            },
            last_ok_at: None,
        };
        let app = Arc::new(App {
            cfg,
            backend,
            sim,
            store: Mutex::new(store),
            engine: Mutex::new(engine),
            server: Mutex::new(server),
            recent: Mutex::new(vec![]),
            counts: Mutex::new((0, 0, 0)),
            snapshot_tx,
            wake_tx: Mutex::new(wake_tx),
            sessions: Mutex::new(HashMap::new()),
            credits_enabled: Mutex::new(None),
            epoch: Instant::now(),
            clock_skip_ms: std::sync::atomic::AtomicU64::new(0),
        });
        app.load_from_store();
        (app, wake_rx, snapshot_rx)
    }

    pub fn mode(&self) -> Mode {
        self.cfg.mode
    }

    pub fn now_ms(&self) -> u64 {
        self.epoch.elapsed().as_millis() as u64 + self.clock_skip_ms.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Wall-clock time for recording weighings. The skip is only ever
    /// non-zero in tests, which move both clocks together.
    fn wall_now(&self) -> String {
        let skip = self.clock_skip_ms.load(std::sync::atomic::Ordering::Relaxed) as i64;
        (Utc::now() + chrono::Duration::milliseconds(skip)).to_rfc3339_opts(SecondsFormat::Millis, true)
    }

    #[cfg(test)]
    fn skip_clock(&self, ms: u64) {
        self.clock_skip_ms.fetch_add(ms, std::sync::atomic::Ordering::Relaxed);
    }

    fn load_from_store(&self) {
        let store = self.store.lock().unwrap();
        let carriers = store.carriers().unwrap_or_default();
        let mut e = self.engine.lock().unwrap();
        Self::set_carriers(&mut e, carriers);
        // Re-arm the duplicate guard from weighings recorded before a restart.
        let guard = e.machine.params.duplicate_guard_ms as i64;
        let now_utc = Utc::now();
        let since = (now_utc - chrono::Duration::milliseconds(guard)).to_rfc3339_opts(SecondsFormat::Millis, true);
        let now = self.now_ms();
        for (carrier_id, at) in store.recent_by_carrier(&since).unwrap_or_default() {
            if let Ok(t) = DateTime::parse_from_rfc3339(&at) {
                let ago = (now_utc.timestamp_millis() - t.timestamp_millis()).max(0) as u64;
                e.machine.seed_recent(&carrier_id, now, ago);
            }
        }
        drop(e);
        drop(store);
        self.refresh_caches();
    }

    fn set_carriers(e: &mut Engine, carriers: Vec<CarrierInfo>) {
        e.carrier_count = carriers.len();
        e.carriers_by_tag = carriers.into_iter().filter_map(|c| c.rfid_tag.clone().map(|t| (t, c))).collect();
    }

    fn refresh_caches(&self) {
        let store = self.store.lock().unwrap();
        *self.recent.lock().unwrap() = store.recent(25).unwrap_or_default();
        *self.counts.lock().unwrap() = store.counts().unwrap_or((0, 0, 0));
    }

    pub fn wake(&self, w: Wake) {
        let _ = self.wake_tx.lock().unwrap().send(w);
    }

    // ------------------------------------------------------------------
    // Hardware input

    pub fn handle(&self, input: Input) {
        let mut recorded = false;
        {
            let mut guard = self.engine.lock().unwrap();
            let e = &mut *guard;
            let now = self.now_ms();
            match input {
                Input::Reading(r) => {
                    if let Some(rs) = e.registering.as_mut() {
                        rs.reg.on_reading(r, now);
                    } else if let Some(draft) = e.machine.on_reading(r, now, &e.carriers_by_tag) {
                        recorded = self.record(e, draft);
                    }
                }
                Input::Tag(t) => {
                    e.machine.last_tag = Some((t.clone(), now));
                    if let Some(rs) = e.registering.as_mut() {
                        rs.reg.on_tag(&t, now);
                    } else {
                        e.machine.on_tag(&t, now);
                    }
                }
                Input::Link(LinkKind::Scale, s) => e.scale_link = s,
                Input::Link(LinkKind::Rfid, s) => e.rfid_link = s,
            }
        }
        if recorded {
            self.refresh_caches();
            self.wake(Wake::Upload);
        }
        self.publish();
    }

    pub fn tick(&self) {
        // Register Bins closes by itself when its person's session runs out.
        let token = self.engine.lock().unwrap().registering.as_ref().map(|r| r.token.clone());
        if let Some(t) = token {
            if self.session_get_quiet(&t).is_none() {
                self.stop_registration();
            }
        }
        let mut recorded = false;
        {
            let mut guard = self.engine.lock().unwrap();
            let e = &mut *guard;
            let now = self.now_ms();
            if let Some(rs) = e.registering.as_mut() {
                rs.reg.tick(now);
            } else if let Some(draft) = e.machine.tick(now, &e.carriers_by_tag) {
                recorded = self.record(e, draft);
            }
        }
        if recorded {
            self.refresh_caches();
            self.wake(Wake::Upload);
        }
        self.publish();
    }

    /// Persists a weighing before anything else sees it. Returns false (and
    /// un-records it in the state machine) if the write failed.
    fn record(&self, e: &mut Engine, d: RecordDraft) -> bool {
        let w = Weighing {
            id: uuid::Uuid::new_v4().to_string(),
            carrier_id: d.bin.carrier_id.clone(),
            carrier_name: d.bin.carrier_name.clone(),
            rfid_tag: d.bin.tag.clone(),
            gross_g: d.gross_g,
            tare_g: d.bin.tare_g,
            net_g: d.net_g,
            recorded_at: self.wall_now(),
            samples_g: d.samples_g,
            simulated: self.mode().is_test(),
            upload_state: "queued".into(),
            upload_attempts: 0,
            last_error: None,
            assignment_status: "unknown".into(),
            employee_name: None,
            pending_until: None,
            credits_live: None,
        };
        match self.store.lock().unwrap().insert_weighing(&w) {
            Ok(()) => {
                eprintln!(
                    "recorded weighing {} {} net {} g{}",
                    w.id,
                    w.carrier_name,
                    w.net_g,
                    if w.simulated { " (SIMULATED)" } else { "" }
                );
                e.last_recorded_id = Some(w.id);
                true
            }
            Err(err) => {
                eprintln!("FAILED to save weighing for {}: {err}", d.bin.carrier_name);
                e.machine.record_failed(d.bin, err);
                false
            }
        }
    }

    // ------------------------------------------------------------------
    // Server sync (runs on the uploader thread; blocking calls are fine)

    fn server_ok(&self) {
        let mut s = self.server.lock().unwrap();
        s.last_ok_at = Some(utc_now());
        s.status = test_server_status(self.mode()).unwrap_or_else(|| LinkStatus::new("online", "Connected"));
    }

    fn server_failed(&self, err: &BackendError) {
        let mut s = self.server.lock().unwrap();
        let detail = err.message();
        s.status = LinkStatus::new(if self.mode().is_test() { "simulated-offline" } else { "offline" }, detail);
    }

    pub fn refresh_carriers(&self) -> bool {
        match self.backend.fetch_carriers() {
            Ok(carriers) => {
                self.server_ok();
                if let Err(e) = self.store.lock().unwrap().replace_carriers(&carriers, &utc_now()) {
                    eprintln!("carrier cache write failed: {e}");
                }
                Self::set_carriers(&mut self.engine.lock().unwrap(), carriers);
                self.publish();
                true
            }
            Err(e) => {
                self.server_failed(&e);
                self.publish();
                false
            }
        }
    }

    /// Whether the server counts this station's weighings as employee
    /// credits yet (trial until an administrator turns them on).
    pub fn refresh_station_info(&self) {
        match self.backend.station_info() {
            Ok(info) => {
                *self.credits_enabled.lock().unwrap() = Some(info.credits_enabled);
                self.publish();
            }
            Err(e) => eprintln!("could not read the station's credit setting: {}", e.message()),
        }
    }

    /// Sends queued weighings oldest-first. Stops at the first connectivity
    /// failure so ordering is preserved. Returns false if the server could
    /// not be reached.
    pub fn upload_queued(&self) -> bool {
        loop {
            let batch = self.store.lock().unwrap().queued(20).unwrap_or_default();
            if batch.is_empty() {
                return true;
            }
            for w in batch {
                if w.simulated != self.mode().is_test() {
                    // Can't happen (DB trigger + mode stamp); never send it anyway.
                    let _ = self.store.lock().unwrap().mark_rejected(&w.id, "mode mismatch");
                    continue;
                }
                match self.backend.submit_weighing(&w) {
                    Ok(r) => {
                        self.server_ok();
                        let _ = self.store.lock().unwrap().mark_sent(&w.id, &utc_now(), &assignment_of(&r));
                    }
                    Err(e) if e.is_permanent_rejection() => {
                        let _ = self.store.lock().unwrap().mark_rejected(&w.id, &e.message());
                    }
                    Err(e) => {
                        self.server_failed(&e);
                        let _ = self.store.lock().unwrap().mark_attempt_failed(&w.id, &e.message());
                        self.refresh_caches();
                        self.publish();
                        return false;
                    }
                }
                self.refresh_caches();
                self.publish();
            }
        }
    }

    /// Mirrors the server's authoritative assignment status for every
    /// recent weighing: pending ones (the 24-hour window runs on the server)
    /// and credited / under-review ones, so a credit is never shown after the
    /// server has stopped holding it. The station never decides credit itself.
    pub fn refresh_assignments(&self) {
        let since = (Utc::now() - chrono::Duration::hours(VERIFY_WINDOW_HOURS)).to_rfc3339_opts(SecondsFormat::Millis, true);
        let list = self.store.lock().unwrap().to_verify(&since).unwrap_or_default();
        for chunk in list.chunks(100) {
            let ids: Vec<String> = chunk.iter().map(|w| w.id.clone()).collect();
            match self.backend.weighing_statuses(&ids) {
                Ok(statuses) => {
                    self.server_ok();
                    let mut store = self.store.lock().unwrap();
                    for id in &ids {
                        match statuses.get(id) {
                            Some(r) => {
                                if let Err(e) = store.update_assignment(id, &utc_now(), &assignment_of(r)) {
                                    eprintln!("could not store status for {id}: {e}");
                                }
                            }
                            None => {
                                // The server doesn't know it: send it again (idempotent).
                                let _ = store.requeue(id);
                                self.wake(Wake::Upload);
                            }
                        }
                    }
                }
                Err(e) => {
                    self.server_failed(&e);
                    break;
                }
            }
        }
        self.refresh_caches();
        self.publish();
    }

    // ------------------------------------------------------------------
    // Signed-in person (Register Bins)

    pub fn session_put(&self, s: UserSession) -> String {
        let token = uuid::Uuid::new_v4().to_string();
        self.sessions.lock().unwrap().insert(token.clone(), (s, Instant::now()));
        token
    }

    /// The session behind a local token; using it keeps it alive.
    pub fn session_get(&self, token: &str) -> Option<UserSession> {
        let mut m = self.sessions.lock().unwrap();
        m.retain(|_, (_, at)| at.elapsed() < SESSION_IDLE);
        let entry = m.get_mut(token)?;
        entry.1 = Instant::now();
        Some(entry.0.clone())
    }

    fn session_get_quiet(&self, token: &str) -> Option<UserSession> {
        let m = self.sessions.lock().unwrap();
        m.get(token).filter(|(_, at)| at.elapsed() < SESSION_IDLE).map(|(s, _)| s.clone())
    }

    /// Signs the person out here and on the server.
    pub fn session_drop(&self, token: &str) {
        let removed = self.sessions.lock().unwrap().remove(token);
        let open = self.engine.lock().unwrap().registering.as_ref().is_some_and(|r| r.token == token);
        if open {
            self.stop_registration();
        }
        if let Some((s, _)) = removed {
            self.backend.user_logout(&s);
        }
    }

    // ------------------------------------------------------------------
    // Register Bins

    pub fn start_registration(&self, token: &str) -> Result<(), RegisterError> {
        let s = self.session_get(token).ok_or(RegisterError::Session)?;
        {
            let mut e = self.engine.lock().unwrap();
            if e.registering.as_ref().is_some_and(|r| r.token != token) {
                return Err(RegisterError::Refused("Someone else is registering bins on this station.".into()));
            }
            if e.registering.is_none() {
                eprintln!("Register Bins opened by {}; weighing paused", s.name);
                let params = e.machine.params.clone();
                e.registering = Some(RegisterSession {
                    reg: Registration::new(params),
                    token: token.to_string(),
                    person: s.name.clone(),
                });
            }
        }
        self.publish();
        Ok(())
    }

    /// Back to weighing, which starts over: a bin still on the scale must be
    /// removed before anything is weighed.
    pub fn stop_registration(&self) {
        {
            let mut e = self.engine.lock().unwrap();
            if e.registering.take().is_some() {
                eprintln!("Register Bins closed; weighing resumes");
                e.machine.resume();
            }
        }
        self.wake(Wake::RefreshCarriers);
        self.publish();
    }

    fn registering_session(&self, token: &str) -> Result<UserSession, RegisterError> {
        let s = self.session_get(token).ok_or(RegisterError::Session)?;
        let open = self.engine.lock().unwrap().registering.as_ref().is_some_and(|r| r.token == token);
        if !open {
            return Err(RegisterError::Refused("Register Bins is not open.".into()));
        }
        Ok(s)
    }

    pub fn find_bins(&self, token: &str, query: &str) -> Result<Vec<crate::backend::RegBin>, RegisterError> {
        let s = self.registering_session(token)?;
        self.backend.find_bins(&s, query).map_err(RegisterError::Server)
    }

    /// The bin the measured tag is already registered to, if any, so the
    /// person sees it before confirming.
    pub fn proposal_tag_owner(&self, token: &str) -> Result<serde_json::Value, RegisterError> {
        let s = self.registering_session(token)?;
        let tag = match &self.engine.lock().unwrap().registering.as_ref().map(|r| r.reg.phase.clone()) {
            Some(RegPhase::Proposed { proposal }) => proposal.tag.clone(),
            _ => return Ok(serde_json::json!({ "tag": null, "bin": null })),
        };
        let bin = self.backend.bin_for_tag(&s, &tag).map_err(RegisterError::Server)?;
        Ok(serde_json::json!({ "tag": tag, "bin": bin }))
    }

    /// Registers the measured bin. The station re-checks the measurement at
    /// this moment (still on the scale, same stable gross, one tag); the
    /// server re-checks everything else and writes the audit trail.
    pub fn confirm_registration(&self, token: &str, choice: ConfirmChoice) -> Result<RegistrationOutcome, RegisterError> {
        let s = self.registering_session(token)?;
        if !choice.empty_confirmed {
            return Err(RegisterError::Refused("Confirm that the bin is completely empty.".into()));
        }
        let proposal = {
            let mut e = self.engine.lock().unwrap();
            let now = self.now_ms();
            let rs = e.registering.as_mut().ok_or_else(|| RegisterError::Refused("Register Bins is not open.".into()))?;
            rs.reg.confirm(now).map_err(RegisterError::Refused)?
        };
        self.publish();
        let tare_kg = round_kg(g_to_kg(proposal.gross_g));
        let req = RegistrationRequest {
            registration_id: proposal.id.clone(),
            carrier_id: choice.carrier_id.clone(),
            rfid_tag: proposal.tag.clone(),
            tare_kg,
            measured: Measured {
                gross_kg: tare_kg,
                samples_kg: proposal.samples_g.iter().map(|g| g_to_kg(*g)).collect(),
                status: "gross",
                stable_ms: proposal.stable_ms,
            },
            expected: choice.expected.clone(),
            empty_confirmed: true,
            confirm_overwrite: choice.confirm_overwrite,
            move_from_carrier_id: choice.move_from_carrier_id.clone(),
        };
        let result = self.backend.register_bin(&s, &req);
        {
            let mut e = self.engine.lock().unwrap();
            if let Some(rs) = e.registering.as_mut() {
                match &result {
                    Ok(o) => {
                        eprintln!(
                            "{} registered {} with tag {} and tare {:.2} kg",
                            rs.person, o.carrier.name, proposal.tag, o.carrier.tare_weight_kg
                        );
                        rs.reg.saved(o.carrier.name.clone(), proposal.tag.clone(), crate::backend::kg_to_g(o.carrier.tare_weight_kg));
                    }
                    Err(_) => rs.reg.save_failed(),
                }
            }
        }
        if result.is_ok() {
            self.wake(Wake::RefreshCarriers);
        }
        self.publish();
        result.map_err(RegisterError::Server)
    }

    /// Takes a tag off a bin (a correction).
    pub fn remove_tag(&self, token: &str, carrier_id: String, expected: Expected, reason: Option<String>) -> Result<RegistrationOutcome, RegisterError> {
        let s = self.registering_session(token)?;
        let req = RemoveTagRequest {
            registration_id: uuid::Uuid::new_v4().to_string(),
            carrier_id,
            expected,
            confirm: true,
            reason,
        };
        let r = self.backend.remove_tag(&s, &req).map_err(RegisterError::Server)?;
        self.wake(Wake::RefreshCarriers);
        Ok(r)
    }

    pub fn last_tag(&self) -> serde_json::Value {
        let e = self.engine.lock().unwrap();
        match &e.machine.last_tag {
            Some((tag, at)) => {
                let carrier = e.carriers_by_tag.get(tag);
                serde_json::json!({
                    "tag": tag,
                    "secondsAgo": self.now_ms().saturating_sub(*at) / 1000,
                    "carrierId": carrier.map(|c| c.id.clone()),
                    "carrierName": carrier.map(|c| c.name.clone()),
                })
            }
            None => serde_json::Value::Null,
        }
    }

    // ------------------------------------------------------------------
    // Snapshot

    pub fn snapshot(&self) -> serde_json::Value {
        let e = self.engine.lock().unwrap();
        let now = self.now_ms();
        let registration = e.registering.as_ref().map(|rs| {
            let reading = rs.reg.last_reading();
            serde_json::json!({
                "person": rs.person,
                "phase": rs.reg.phase,
                "reading": reading,
                "scaleOnline": rs.reg.scale_online,
                "settleRemainingMs": rs.reg.settle_remaining_ms(now),
                "clearRemainingMs": rs.reg.clear_remaining_ms(now),
            })
        });
        let p = &e.machine.params;
        let settle_remaining_ms = match &e.machine.phase {
            Phase::Settling { started_ms, .. } => {
                let left = p.settle_ms.saturating_sub(now.saturating_sub(*started_ms));
                left.div_ceil(100) * 100
            }
            _ => 0,
        };
        let removal_remaining_ms = match &e.machine.phase {
            Phase::AwaitingRemoval { empty_since_ms: Some(s), .. } | Phase::Blocked { empty_since_ms: Some(s), .. } => {
                p.removal_ms.saturating_sub(now.saturating_sub(*s)).div_ceil(100) * 100
            }
            _ => 0,
        };
        let reading = match &e.registering {
            Some(rs) => rs.reg.last_reading().cloned(),
            None => e.machine.last_reading().cloned(),
        };
        let scale_online = match &e.registering {
            Some(rs) => rs.reg.scale_online,
            None => e.machine.scale_online,
        };
        let bin = e.machine.current_bin().cloned();
        let live_net_g = match (&bin, reading.as_ref().and_then(|r| r.weight_g)) {
            (Some(b), Some(w)) => Some(w - b.tare_g),
            _ => None,
        };
        let recent = self.recent.lock().unwrap().clone();
        let current = match (&e.machine.phase, &e.last_recorded_id) {
            (
                Phase::AwaitingRemoval {
                    reason: crate::machine::RemovalReason::Recorded,
                    ..
                },
                Some(id),
            ) => recent.iter().find(|w| &w.id == id).cloned(),
            _ => None,
        };
        let (queued, pending, attention) = *self.counts.lock().unwrap();
        let server = self.server.lock().unwrap();
        let last_tag = e.machine.last_tag.as_ref().map(|(tag, at)| {
            serde_json::json!({ "tag": tag, "secondsAgo": now.saturating_sub(*at) / 1000, "carrierName": e.carriers_by_tag.get(tag).map(|c| c.name.clone()) })
        });
        serde_json::json!({
            "mode": self.mode().as_str(),
            "simulated": self.mode() == Mode::Simulation,
            "stationName": self.cfg.station_name,
            "phase": e.machine.phase,
            "settleRemainingMs": settle_remaining_ms,
            "removalRemainingMs": removal_remaining_ms,
            "waitForZero": e.machine.wait_for_zero,
            "scaleOnline": scale_online,
            "reading": reading,
            "bin": bin,
            "liveNetG": live_net_g,
            "currentWeighing": current,
            "recent": recent,
            "lastTag": last_tag,
            "connections": {
                "scale": e.scale_link,
                "rfid": e.rfid_link,
                "server": server.status,
                "serverLastOkAt": server.last_ok_at,
            },
            "outbox": { "queued": queued, "pending": pending, "attention": attention },
            "carrierCount": e.carrier_count,
            "params": p,
            "rig": self.sim.as_ref().map(|(_, rig)| rig.view()),
            "registration": registration,
            "creditsEnabled": *self.credits_enabled.lock().unwrap(),
        })
    }

    pub fn publish(&self) {
        let json = Arc::new(self.snapshot().to_string());
        self.snapshot_tx.send_if_modified(|cur| {
            if **cur == *json {
                false
            } else {
                *cur = json.clone();
                true
            }
        });
    }
}

fn assignment_of(r: &crate::backend::AssignmentResult) -> Assignment<'_> {
    let status = normalize_status(&r.status);
    Assignment {
        status,
        // Only a credit (or a voided credit) names an employee.
        employee: if status == "credited" || status == "voided" { r.employee_name.as_deref() } else { None },
        pending_until: r.pending_until.as_deref(),
        credits_live: r.credits_live,
    }
}

fn round_kg(kg: f64) -> f64 {
    (kg * 100.0).round() / 100.0
}

/// Uploader loop: carrier cache refresh, outbox upload with backoff, and
/// pending-assignment polling. Runs on its own OS thread.
pub fn run_uploader(app: Arc<App>, rx: Receiver<Wake>) {
    let poll_every = if app.mode().is_test() {
        Duration::from_secs(2)
    } else {
        Duration::from_secs(app.cfg.pending_poll_seconds.max(10))
    };
    let refresh_every = Duration::from_secs(app.cfg.carrier_refresh_seconds.max(30));
    let mut next_carriers = Instant::now();
    let mut next_upload = Instant::now();
    let mut next_poll = Instant::now();
    let mut backoff = Duration::from_secs(5);
    loop {
        let now = Instant::now();
        let next = next_carriers.min(next_upload).min(next_poll);
        let wait = next.saturating_duration_since(now).min(Duration::from_secs(5));
        match rx.recv_timeout(wait) {
            Ok(Wake::Upload) => {
                next_upload = Instant::now();
                next_poll = Instant::now();
            }
            Ok(Wake::RefreshCarriers) => next_carriers = Instant::now(),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        let now = Instant::now();
        if now >= next_carriers {
            let ok = app.refresh_carriers();
            if ok {
                app.refresh_station_info();
            }
            next_carriers = now + if ok { refresh_every } else { Duration::from_secs(15) };
        }
        if now >= next_upload {
            if app.upload_queued() {
                backoff = Duration::from_secs(5);
                next_upload = now + Duration::from_secs(30);
            } else {
                next_upload = now + backoff;
                backoff = (backoff * 2).min(Duration::from_secs(120));
            }
        }
        if now >= next_poll {
            app.refresh_assignments();
            next_poll = now + poll_every;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scale_proto::IndicatorMode;

    fn sim_app() -> Arc<App> {
        let server = Arc::new(SimServer::new());
        let rig = Arc::new(SimRig::new());
        let (app, _rx, _snap) = App::new(
            Config::default(),
            Store::open_in_memory(Mode::Simulation).unwrap(),
            server.clone(),
            Some((server, rig)),
        );
        app
    }

    fn gross(g: i64) -> Reading {
        Reading {
            weight_g: Some(g),
            mode: IndicatorMode::Gross,
            motion: false,
            overload: false,
            underload: false,
            error: false,
        }
    }

    /// Feeds `secs` seconds of 10 Hz readings in simulated time.
    fn hold(app: &App, g: i64, secs: u64) {
        for _ in 0..secs * 10 {
            app.skip_clock(100);
            app.handle(Input::Reading(gross(g)));
        }
    }

    fn weigh(app: &App, tag: &str, g: i64) {
        hold(app, 0, 3);
        app.handle(Input::Tag(tag.into()));
        hold(app, g, 13);
    }

    #[test]
    fn end_to_end_weighing_is_saved_uploaded_and_credited_in_simulation() {
        let app = sim_app();
        assert!(app.refresh_carriers());
        let (server, _) = app.sim.clone().unwrap();
        server
            .add_claim("sim-employee-3", crate::sim::ScanTiming::MinutesAgo("sim-carrier-01".into(), 20), true)
            .unwrap();

        hold(&app, 0, 1);
        app.handle(Input::Tag("0000000182225750".into()));
        hold(&app, 64_000, 9);
        let snap = app.snapshot();
        assert_eq!(snap["phase"]["phase"], "settling", "{snap}");
        assert!(snap["settleRemainingMs"].as_u64().unwrap() > 0);
        assert_eq!(snap["liveNetG"], 64_000 - 27_500);
        hold(&app, 64_000, 3);
        let snap = app.snapshot();
        assert_eq!(snap["phase"]["phase"], "awaitingRemoval", "{snap}");
        assert_eq!(snap["outbox"]["queued"], 1);

        assert!(app.upload_queued());
        let w = app.recent.lock().unwrap()[0].clone();
        assert!(w.simulated);
        assert_eq!(w.assignment_status, "credited");
        assert_eq!(w.employee_name.as_deref(), Some("Picker Charlie"));
        assert_eq!(w.net_g, 64_000 - 27_500);
        assert_eq!(app.snapshot()["currentWeighing"]["employeeName"], "Picker Charlie");
    }

    /// Hardware-test mode as main.rs builds it: the test server holding the
    /// configured bins, no simulator rig, readings from the serial parsers.
    fn hardware_test_app(store: Store) -> Arc<App> {
        let cfg: Config = serde_json::from_str(
            r#"{"mode":"hardware-test","testCarriers":[{"name":"Bin 23","rfidTag":"0000000182225750","tareKg":27.5}]}"#,
        )
        .unwrap();
        cfg.validate().unwrap();
        let server = Arc::new(SimServer::with_carriers(cfg.test_carrier_infos().unwrap()));
        let (app, _rx, _snap) = App::new(cfg, store, server, None);
        app
    }

    /// One R300 frame through the same framer and parser as the serial port.
    fn r300(app: &App, body: &str, secs: u64) {
        let mut framer = crate::scale_proto::ScaleFramer::default();
        let frame = framer.push(format!("\x02{body}\x03").as_bytes()).pop().unwrap();
        let reading = crate::scale_proto::parse_frame(crate::scale_proto::ScaleProtocol::RinstrumAutoA, &frame).unwrap();
        for _ in 0..secs * 10 {
            app.skip_clock(100);
            app.handle(Input::Reading(reading.clone()));
        }
    }

    #[test]
    fn hardware_test_mode_weighs_real_frames_against_test_bins_and_sends_nothing_real() {
        let app = hardware_test_app(Store::open_in_memory(Mode::HardwareTest).unwrap());
        assert!(app.sim.is_none(), "no simulator rig or /api/sim controls in hardware-test mode");
        let snap = app.snapshot();
        assert_eq!((snap["mode"].as_str(), snap["simulated"].as_bool()), (Some("hardware-test"), Some(false)));
        assert_eq!(snap["connections"]["scale"]["state"], "disconnected", "real ports, not simulated");
        assert_eq!(snap["connections"]["server"]["state"], "simulated");
        assert!(snap["connections"]["server"]["detail"].as_str().unwrap().contains("Nothing is sent to LabourLink"));
        assert!(app.refresh_carriers());
        assert_eq!(app.snapshot()["carrierCount"], 1);

        // Empty, then the bin with its tag, then a stable 110.2 kg from the indicator.
        r300(&app, "     0.0G", 3);
        app.handle(Input::Tag("0000000182225750".into()));
        r300(&app, "   110.2M", 2); // motion while it's put down
        r300(&app, "   110.2G", 13);
        let snap = app.snapshot();
        assert_eq!(snap["phase"]["phase"], "awaitingRemoval", "{snap}");
        let w = app.recent.lock().unwrap()[0].clone();
        assert_eq!((w.gross_g, w.tare_g, w.net_g), (110_200, 27_500, 82_700));
        assert!(w.simulated, "hardware-test weighings are stored as test data");

        // The test server holds it pending: nobody is credited without a scan.
        assert!(app.upload_queued());
        let w = app.recent.lock().unwrap()[0].clone();
        assert_eq!((w.upload_state.as_str(), w.assignment_status.as_str(), w.employee_name.as_deref()), ("sent", "pending", None));
        assert_eq!(app.snapshot()["outbox"]["pending"], 1);

        // Duplicate prevention: lifted and put straight back is not recorded again.
        r300(&app, "     0.0G", 3);
        app.handle(Input::Tag("0000000182225750".into()));
        r300(&app, "   110.2G", 13);
        assert_eq!(app.snapshot()["phase"]["reason"]["code"], "recentlyWeighed");
        assert_eq!(app.recent.lock().unwrap().len(), 1);

        // A real tag that isn't in testCarriers is never weighed.
        r300(&app, "     0.0G", 3);
        app.handle(Input::Tag("0000000155555555".into()));
        r300(&app, "    93.0G", 13);
        assert_eq!(app.snapshot()["phase"]["reason"]["code"], "unknownTag");
        assert_eq!(app.recent.lock().unwrap().len(), 1);
    }

    #[test]
    fn hardware_test_mode_has_its_own_database() {
        let dir = tempfile::tempdir().unwrap();
        // A simulation or live database can't be opened in hardware-test mode, or vice versa.
        let sim_db = dir.path().join("scale-sim.sqlite3");
        drop(Store::open(&sim_db, Mode::Simulation).unwrap());
        assert!(Store::open(&sim_db, Mode::HardwareTest).is_err());
        let hw_db = dir.path().join("scale-hwtest.sqlite3");
        drop(Store::open(&hw_db, Mode::HardwareTest).unwrap());
        assert!(Store::open(&hw_db, Mode::Live).is_err());
        assert!(Store::open(&hw_db, Mode::Simulation).is_err());
        // Its rows are test data: the store refuses a real one.
        let app = hardware_test_app(Store::open(&hw_db, Mode::HardwareTest).unwrap());
        assert!(app.refresh_carriers());
        r300(&app, "     0.0G", 3);
        app.handle(Input::Tag("0000000182225750".into()));
        r300(&app, "    93.0G", 13);
        let mut w = app.recent.lock().unwrap()[0].clone();
        assert_eq!(w.net_g, 93_000 - 27_500);
        w.id = "another".into();
        w.simulated = false;
        assert!(app.store.lock().unwrap().insert_weighing(&w).is_err());
    }

    #[test]
    fn outbox_holds_weighings_through_an_outage_and_sends_in_order() {
        let app = sim_app();
        assert!(app.refresh_carriers());
        let (server, _) = app.sim.clone().unwrap();
        server.set_online(false);
        weigh(&app, "0000000182225750", 64_000);
        weigh(&app, "0000000182225751", 58_000);
        assert!(!app.upload_queued());
        assert_eq!(app.snapshot()["outbox"]["queued"], 2);
        assert_eq!(app.snapshot()["connections"]["server"]["state"], "simulated-offline");
        server.set_online(true);
        assert!(app.upload_queued());
        assert_eq!(app.snapshot()["outbox"]["queued"], 0);
        assert_eq!(app.snapshot()["outbox"]["pending"], 2, "no phone claims yet: both pending, nobody credited");
    }

    #[test]
    fn weighing_unknown_to_the_server_is_resent_not_lost() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("scale-sim.sqlite3");
        let make = || {
            let server = Arc::new(SimServer::new());
            let (app, _rx, _snap) = App::new(
                Config::default(),
                Store::open(&path, Mode::Simulation).unwrap(),
                server.clone(),
                Some((server, Arc::new(SimRig::new()))),
            );
            assert!(app.refresh_carriers());
            app
        };
        let app = make();
        weigh(&app, "0000000182225750", 64_000);
        assert!(app.upload_queued());
        assert_eq!(app.snapshot()["outbox"]["pending"], 1);
        drop(app);
        // A fresh server that has never seen the weighing.
        let app = make();
        app.refresh_assignments();
        assert_eq!(app.snapshot()["outbox"]["queued"], 1, "re-queued for upload");
        assert!(app.upload_queued());
        assert_eq!(app.snapshot()["outbox"]["pending"], 1);
        assert_eq!(app.snapshot()["connections"]["server"]["state"], "simulated");
    }

    #[test]
    fn restart_rearms_the_duplicate_guard_from_sqlite() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("scale-sim.sqlite3");
        let make = || {
            let server = Arc::new(SimServer::new());
            let (app, _rx, _snap) = App::new(
                Config::default(),
                Store::open(&path, Mode::Simulation).unwrap(),
                server.clone(),
                Some((server, Arc::new(SimRig::new()))),
            );
            assert!(app.refresh_carriers());
            app
        };
        let app = make();
        weigh(&app, "0000000182225750", 64_000);
        assert_eq!(app.snapshot()["outbox"]["queued"], 1);
        drop(app);
        // Service restarts; the same bin is put back on the scale.
        let app = make();
        weigh(&app, "0000000182225750", 64_000);
        let snap = app.snapshot();
        assert_eq!(snap["phase"]["reason"]["code"], "recentlyWeighed", "{snap}");
        assert_eq!(snap["outbox"]["queued"], 1, "no second weighing");
    }

    // ---- Regression: independent bin-use cycles, server-authoritative credit ----

    const TAG_BIN1: &str = "0000000182225750";
    const TAG_BIN2: &str = "0000000182225751";
    const SIX_MIN_MS: u64 = 6 * 60_000;

    fn sim_server(app: &App) -> Arc<SimServer> {
        app.sim.clone().unwrap().0
    }

    fn latest(app: &App) -> Weighing {
        app.recent.lock().unwrap()[0].clone()
    }

    /// Station status of a weighing, as the display would show it.
    fn shown(app: &App, id: &str) -> (String, Option<String>) {
        let w = app.recent.lock().unwrap().iter().find(|w| w.id == id).cloned().unwrap();
        (w.assignment_status, w.employee_name)
    }

    fn scan_before(app: &App, employee: &str, weighing_id: &str) {
        sim_server(app)
            .add_claim(employee, crate::sim::ScanTiming::BeforeWeighing(weighing_id.into()), true)
            .unwrap();
        app.refresh_assignments();
    }

    fn credited(name: &str) -> (String, Option<String>) {
        ("credited".into(), Some(name.into()))
    }

    #[test]
    fn station_bin1_bin2_bin1_credits_each_use_and_keeps_history() {
        let app = sim_app();
        assert!(app.refresh_carriers());
        weigh(&app, TAG_BIN1, 113_000);
        assert!(app.upload_queued());
        let w1 = latest(&app).id;
        assert_eq!(shown(&app, &w1).0, "pending");
        scan_before(&app, "sim-employee-1", &w1);
        assert_eq!(shown(&app, &w1), credited("Picker Alpha"));

        weigh(&app, TAG_BIN2, 148_350);
        assert!(app.upload_queued());
        let w2 = latest(&app).id;
        scan_before(&app, "sim-employee-2", &w2);
        assert_eq!(shown(&app, &w2), credited("Picker Bravo"));

        // Bin 1 emptied, reassigned and weighed again after the duplicate guard.
        hold(&app, 0, 3);
        app.skip_clock(SIX_MIN_MS);
        weigh(&app, TAG_BIN1, 238_400);
        assert!(app.upload_queued());
        let w3 = latest(&app).id;
        assert_ne!(w3, w1);
        assert_eq!(latest(&app).carrier_name, "Sim Bin 1");
        assert_eq!(shown(&app, &w3).0, "pending", "the earlier credited use doesn't block this one");
        scan_before(&app, "sim-employee-3", &w3);
        assert_eq!(shown(&app, &w3), credited("Picker Charlie"));
        assert_eq!(shown(&app, &w1), credited("Picker Alpha"));
        assert_eq!(shown(&app, &w2), credited("Picker Bravo"));
    }

    #[test]
    fn station_same_bin_used_twice_by_different_employees() {
        let app = sim_app();
        assert!(app.refresh_carriers());
        weigh(&app, TAG_BIN1, 90_000);
        assert!(app.upload_queued());
        let w1 = latest(&app).id;
        scan_before(&app, "sim-employee-1", &w1);
        hold(&app, 0, 3);
        app.skip_clock(SIX_MIN_MS);
        weigh(&app, TAG_BIN1, 95_000);
        assert!(app.upload_queued());
        let w2 = latest(&app).id;
        scan_before(&app, "sim-employee-4", &w2);
        assert_eq!(shown(&app, &w1), credited("Picker Alpha"));
        assert_eq!(shown(&app, &w2), credited("Picker Delta"));
    }

    #[test]
    fn repeated_rfid_reads_and_steady_readings_make_exactly_one_weighing() {
        let app = sim_app();
        assert!(app.refresh_carriers());
        hold(&app, 0, 3);
        for _ in 0..600 {
            // 60 s on the scale: a tag read every 500 ms, a reading every 100 ms.
            app.skip_clock(100);
            if app.now_ms() % 500 < 100 {
                app.handle(Input::Tag(TAG_BIN1.into()));
            }
            app.handle(Input::Reading(gross(90_000)));
        }
        assert_eq!(app.recent.lock().unwrap().len(), 1);
    }

    #[test]
    fn lift_and_replace_within_five_minutes_is_not_a_new_weighing() {
        let app = sim_app();
        assert!(app.refresh_carriers());
        weigh(&app, TAG_BIN1, 90_000);
        weigh(&app, TAG_BIN1, 90_000); // removed and put straight back
        assert_eq!(app.snapshot()["phase"]["reason"]["code"], "recentlyWeighed");
        assert_eq!(app.recent.lock().unwrap().len(), 1);
    }

    #[test]
    fn station_never_shows_a_credit_the_server_no_longer_holds() {
        let app = sim_app();
        assert!(app.refresh_carriers());
        let server = sim_server(&app);
        server
            .add_claim("sim-employee-1", crate::sim::ScanTiming::MinutesAgo("sim-carrier-01".into(), 5), true)
            .unwrap();
        weigh(&app, TAG_BIN1, 90_000);
        assert!(app.upload_queued());
        let w1 = latest(&app).id;
        assert_eq!(shown(&app, &w1), credited("Picker Alpha"));
        // A future authorized correction on the server: the station follows on its next check.
        server.force_status(&w1, crate::matching::AssignmentStatus::NeedsReview);
        app.refresh_assignments();
        assert_eq!(shown(&app, &w1), ("needs_review".to_string(), None));
        assert!(app.snapshot()["currentWeighing"]["employeeName"].is_null());
    }

    #[test]
    fn unrecognised_server_status_is_never_shown_as_credited() {
        assert_eq!(normalize_status("credited"), "credited");
        assert_eq!(normalize_status("needs_review"), "needs_review");
        assert_eq!(normalize_status("credited_pending_audit"), "unknown");
        assert_eq!(normalize_status(""), "unknown");
    }

    #[test]
    fn snapshot_shows_wait_for_zero_until_the_scale_is_ready() {
        let app = sim_app();
        assert!(app.refresh_carriers());
        weigh(&app, TAG_BIN1, 90_000);
        assert_eq!(app.snapshot()["waitForZero"], false);
        hold(&app, 0, 1); // lifted off for only 1 s...
        app.handle(Input::Tag(TAG_BIN2.into()));
        hold(&app, 80_000, 15); // ...and the next bin goes straight on
        let snap = app.snapshot();
        assert_eq!(snap["waitForZero"], true, "{snap}");
        assert_eq!(app.recent.lock().unwrap().len(), 1, "no second weighing yet");
        hold(&app, 0, 3); // scale returns to zero for the full 2 s
        let snap = app.snapshot();
        assert_eq!(snap["waitForZero"], false);
        assert_eq!(snap["phase"]["phase"], "idle");
        weigh(&app, TAG_BIN2, 80_000);
        assert_eq!(app.recent.lock().unwrap().len(), 2);
        assert_eq!(latest(&app).carrier_name, "Sim Bin 2");
    }

    // ------------------------------------------------------------------
    // Register Bins

    fn sign_in(app: &App) -> String {
        let s = app.backend.user_login("picker@sim.local", "1234").unwrap();
        app.session_put(s)
    }

    fn reg_phase(app: &App) -> String {
        app.snapshot()["registration"]["phase"]["phase"].as_str().unwrap_or("none").to_string()
    }

    fn choice(carrier: &str, tag: Option<&str>, tare_kg: f64, overwrite: bool) -> ConfirmChoice {
        ConfirmChoice {
            carrier_id: carrier.into(),
            expected: Expected {
                rfid_tag: tag.map(str::to_string),
                tare_weight_kg: tare_kg,
            },
            empty_confirmed: true,
            confirm_overwrite: overwrite,
            move_from_carrier_id: None,
        }
    }

    const NEW_TAG: &str = "0000000000005555";

    #[test]
    fn register_bins_saves_an_empty_bins_tag_and_tare_and_never_weighs() {
        let app = sim_app();
        assert!(app.refresh_carriers());
        let t = sign_in(&app);

        // A full, registered bin is on the scale when Register Bins opens.
        hold(&app, 0, 3);
        app.handle(Input::Tag("0000000182225750".into()));
        app.start_registration(&t).unwrap();
        hold(&app, 64_000, 15);
        assert_eq!(reg_phase(&app), "clearScale", "nothing is measured until the scale is cleared");

        hold(&app, 0, 3);
        assert_eq!(reg_phase(&app), "ready");
        app.handle(Input::Tag(NEW_TAG.into()));
        hold(&app, 26_400, 13);
        assert_eq!(reg_phase(&app), "proposed");
        let snap = app.snapshot();
        assert_eq!(snap["registration"]["phase"]["proposal"]["grossG"], 26_400);
        assert_eq!(snap["registration"]["phase"]["proposal"]["tag"], NEW_TAG);
        assert_eq!(app.proposal_tag_owner(&t).unwrap()["bin"], serde_json::Value::Null);

        // Never assumed empty.
        let mut not_empty = choice("sim-carrier-13", None, 27.2, false);
        not_empty.empty_confirmed = false;
        assert!(matches!(app.confirm_registration(&t, not_empty), Err(RegisterError::Refused(_))));
        // Sim Bin 13 already has a 27.2 kg tare: replacing it needs confirmation.
        match app.confirm_registration(&t, choice("sim-carrier-13", None, 27.2, false)) {
            Err(RegisterError::Server(BackendError::Http { code, .. })) => assert_eq!(code.as_deref(), Some("needsConfirmation")),
            other => panic!("{other:?}"),
        }
        assert_eq!(reg_phase(&app), "proposed", "a refused save keeps the measurement");
        let out = app.confirm_registration(&t, choice("sim-carrier-13", None, 27.2, true)).unwrap();
        assert_eq!((out.carrier.rfid_tag.as_deref(), out.carrier.tare_weight_kg), (Some(NEW_TAG), 26.4));
        assert_eq!(reg_phase(&app), "saved");

        // Still on the scale: nothing else happens, and nothing was weighed.
        hold(&app, 26_400, 15);
        assert_eq!(reg_phase(&app), "saved");
        assert!(app.store.lock().unwrap().recent(10).unwrap().is_empty(), "registration never creates a weighing");

        // Back to weighing: the bin still on the scale must come off first.
        app.stop_registration();
        assert!(app.snapshot()["registration"].is_null());
        hold(&app, 26_400, 15);
        assert_eq!(app.snapshot()["phase"]["phase"], "awaitingRemoval");
        assert!(app.store.lock().unwrap().recent(10).unwrap().is_empty());

        // The newly registered bin now weighs with its measured tare.
        assert!(app.refresh_carriers());
        weigh(&app, NEW_TAG, 60_000);
        let w = app.store.lock().unwrap().recent(1).unwrap()[0].clone();
        assert_eq!((w.carrier_id.as_str(), w.tare_g, w.net_g), ("sim-carrier-13", 26_400, 33_600));
    }

    #[test]
    fn register_bins_needs_a_signed_in_person_and_closes_when_they_sign_out() {
        let app = sim_app();
        assert!(matches!(app.start_registration("nobody"), Err(RegisterError::Session)));
        let t = sign_in(&app);
        app.start_registration(&t).unwrap();
        assert_eq!(app.snapshot()["registration"]["person"], "Sim Picker");
        let other = sign_in(&app);
        assert!(matches!(app.start_registration(&other), Err(RegisterError::Refused(_))), "one person at a time");
        assert!(matches!(app.find_bins(&other, "13"), Err(RegisterError::Refused(_))));
        app.session_drop(&t);
        assert!(app.snapshot()["registration"].is_null(), "signing out closes Register Bins");
        assert_eq!(app.snapshot()["phase"]["phase"], "starting", "weighing starts over");
    }

    #[test]
    fn trial_credits_are_stored_as_trial_and_the_station_knows_its_credits_are_off() {
        let app = sim_app();
        assert!(app.refresh_carriers());
        let server = sim_server(&app);
        server.set_credits_enabled(false);
        app.refresh_station_info();
        assert_eq!(app.snapshot()["creditsEnabled"], false);
        server
            .add_claim("sim-employee-1", crate::sim::ScanTiming::MinutesAgo("sim-carrier-01".into(), 20), true)
            .unwrap();
        weigh(&app, "0000000182225750", 64_000);
        assert!(app.upload_queued());
        let w = latest(&app);
        assert_eq!((w.assignment_status.as_str(), w.credits_live), ("credited", Some(false)));
        assert_eq!(app.snapshot()["currentWeighing"]["creditsLive"], false);
    }

}
