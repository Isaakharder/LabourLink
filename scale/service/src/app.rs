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

use crate::backend::{AdminSession, Backend, BackendError};
use crate::config::{Config, Mode};
use crate::machine::{CarrierInfo, Machine, Phase, RecordDraft};
use crate::scale_proto::Reading;
use crate::sim::{SimRig, SimServer};
use crate::store::{Store, Weighing};

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
    admin: Mutex<HashMap<String, (AdminSession, Instant)>>,
    epoch: Instant,
    /// Added to the monotonic clock; only tests move it.
    clock_skip_ms: std::sync::atomic::AtomicU64,
}

const ADMIN_IDLE: Duration = Duration::from_secs(15 * 60);

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
        };
        let server = ServerLink {
            status: if simulated {
                LinkStatus::new("simulated", "In-process simulator — no network")
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
            admin: Mutex::new(HashMap::new()),
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
                    if let Some(draft) = e.machine.on_reading(r, now, &e.carriers_by_tag) {
                        recorded = self.record(e, draft);
                    }
                }
                Input::Tag(t) => e.machine.on_tag(&t, now),
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
        let mut recorded = false;
        {
            let mut guard = self.engine.lock().unwrap();
            let e = &mut *guard;
            if let Some(draft) = e.machine.tick(self.now_ms(), &e.carriers_by_tag) {
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
            recorded_at: utc_now(),
            samples_g: d.samples_g,
            simulated: self.mode() == Mode::Simulation,
            upload_state: "queued".into(),
            upload_attempts: 0,
            last_error: None,
            assignment_status: "unknown".into(),
            employee_name: None,
            pending_until: None,
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
        if self.sim.is_none() {
            s.status = LinkStatus::new("online", "Connected");
        } else {
            s.status = LinkStatus::new("simulated", "In-process simulator — no network");
        }
    }

    fn server_failed(&self, err: &BackendError) {
        let mut s = self.server.lock().unwrap();
        let detail = err.message();
        s.status = LinkStatus::new(if self.sim.is_some() { "simulated-offline" } else { "offline" }, detail);
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
                if w.simulated != (self.mode() == Mode::Simulation) {
                    // Can't happen (DB trigger + mode stamp); never send it anyway.
                    let _ = self.store.lock().unwrap().mark_rejected(&w.id, "mode mismatch");
                    continue;
                }
                match self.backend.submit_weighing(&w) {
                    Ok(r) => {
                        self.server_ok();
                        let _ = self
                            .store
                            .lock()
                            .unwrap()
                            .mark_sent(&w.id, &utc_now(), &r.status, r.employee_name.as_deref(), r.pending_until.as_deref());
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

    /// Follows weighings awaiting an employee assignment (the 24-hour
    /// pending recovery window runs on the server; the station only shows it).
    pub fn poll_pending(&self) {
        let list = self.store.lock().unwrap().awaiting_assignment().unwrap_or_default();
        for w in list {
            match self.backend.weighing_status(&w.id) {
                Ok(r) => {
                    self.server_ok();
                    let _ = self
                        .store
                        .lock()
                        .unwrap()
                        .update_assignment(&w.id, &utc_now(), &r.status, r.employee_name.as_deref(), r.pending_until.as_deref());
                }
                Err(BackendError::Http { status: 404, .. }) => {
                    let _ = self.store.lock().unwrap().requeue(&w.id);
                    self.wake(Wake::Upload);
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
    // Admin (RFID registration)

    pub fn admin_put(&self, s: AdminSession) -> String {
        let token = uuid::Uuid::new_v4().to_string();
        self.admin.lock().unwrap().insert(token.clone(), (s, Instant::now()));
        token
    }

    pub fn admin_get(&self, token: &str) -> Option<AdminSession> {
        let mut m = self.admin.lock().unwrap();
        m.retain(|_, (_, at)| at.elapsed() < ADMIN_IDLE);
        let entry = m.get_mut(token)?;
        entry.1 = Instant::now();
        Some(entry.0.clone())
    }

    pub fn admin_drop(&self, token: &str) {
        self.admin.lock().unwrap().remove(token);
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
        let reading = e.machine.last_reading().cloned();
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
            "scaleOnline": e.machine.scale_online,
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

/// Uploader loop: carrier cache refresh, outbox upload with backoff, and
/// pending-assignment polling. Runs on its own OS thread.
pub fn run_uploader(app: Arc<App>, rx: Receiver<Wake>) {
    let poll_every = if app.sim.is_some() {
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
            next_carriers = now + if app.refresh_carriers() { refresh_every } else { Duration::from_secs(15) };
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
            app.poll_pending();
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
        server.add_claim("sim-employee-3", "sim-carrier-01", 20, true).unwrap();

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
        app.poll_pending();
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
}
