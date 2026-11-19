//! Simulation mode: a fake LabourLink server and fake hardware.
//!
//! Nothing here touches the network. `SimServer` implements `Backend` in
//! memory with clearly fake bins and pickers, runs the assignment rule
//! (matching.rs, the same cases as the server) and applies Register Bins
//! with the server's rules (server/src/lib/binRegistration.ts): one tag per
//! bin, stale views refused, overwrites confirmed, explicit tag moves, and a
//! registration applied once. `SimRig` produces indicator frames and RFID
//! lines as raw bytes that go through the same framers and parsers as the
//! serial ports, so the parsing path is exercised too.

use chrono::{DateTime, Utc};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;

use crate::backend::{
    AssignmentResult, Backend, BackendError, Expected, MovedFrom, RegBin, RegistrationOutcome, RegistrationRequest, RemoveTagRequest, StationInfo, UserSession,
};
use crate::machine::CarrierInfo;
use crate::matching::{decide, AssignmentStatus, Claim, WeighingFacts};
use crate::rfid::{is_valid_rfid_tag, normalize_rfid_tag, LineFramer};
use crate::scale_proto::{encode_rinstrum_auto_a, IndicatorMode, Reading, ScaleFramer};
use crate::store::Weighing;

pub const UNREGISTERED_TAG: &str = "0000000099999999";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimEmployee {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimClaimView {
    pub id: String,
    pub employee_name: String,
    pub carrier_name: String,
    pub occurred_at: String,
    pub clock_trusted: bool,
    pub consumed_by: Option<String>,
    /// used | conflict | waiting | cycle_discarded | cycle_in_review | clock_flagged
    pub state: String,
    /// The weighing whose cycle this scan falls in, if that cycle is closed.
    pub weighing_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimWeighingView {
    pub id: String,
    pub carrier_id: String,
    pub carrier_name: String,
    pub weighed_at: String,
    pub status: String,
    pub employee_name: Option<String>,
}

/// When a simulated phone scan happened.
#[derive(Debug, Clone)]
pub enum ScanTiming {
    /// Inside the bin-use cycle that ends with this weighing (between the
    /// bin's previous weighing and this one): a scan that a phone made
    /// before the weighing but synced late.
    BeforeWeighing(String),
    /// Now: a picker taking the bin for its next use.
    Now(String),
    /// Advanced: `minutes` before now, for the given carrier.
    MinutesAgo(String, i64),
}

struct SimWeighing {
    facts: WeighingFacts,
    status: AssignmentStatus,
    /// The station's credit switch when the weighing arrived.
    credits_live: bool,
}

struct Inner {
    carriers: Vec<CarrierInfo>,
    employees: Vec<SimEmployee>,
    claims: Vec<Claim>,
    weighings: Vec<SimWeighing>,
    sessions: HashMap<String, UserSession>,
    /// Register Bins history: (registration id, carrier id, old tag, old
    /// tare g, new tag, new tare g). Used for replays and for restoring a
    /// bin's tare when a mistakenly registered tag is moved off it.
    registrations: Vec<(String, String, Option<String>, i64, Option<String>, i64)>,
    /// claim id -> credited weighing id it conflicts with (flag only).
    conflicts: HashMap<String, String>,
    online: bool,
    /// The station's credit switch (scale_stations.credits_enabled). Off
    /// means trial: weighings are matched but never count as credits.
    credits_enabled: bool,
    next_id: u64,
}

pub struct SimServer {
    inner: Mutex<Inner>,
}

fn ms_to_rfc3339(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default()
}

fn rfc3339_to_ms(s: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis())
}

fn http(status: u16, message: &str) -> BackendError {
    BackendError::http(status, message)
}

/// A refusal shaped like the server's: `{ code, error, ...data }`.
fn refused(status: u16, code: &str, message: String, data: serde_json::Value) -> BackendError {
    let mut body = if data.is_object() { data } else { serde_json::json!({}) };
    body["code"] = serde_json::json!(code);
    body["error"] = serde_json::json!(message);
    BackendError::Http {
        status,
        message,
        errors: BTreeMap::new(),
        code: Some(code.into()),
        body,
    }
}

fn reg_bin(c: &CarrierInfo) -> RegBin {
    RegBin {
        id: c.id.clone(),
        name: c.name.clone(),
        rfid_tag: c.rfid_tag.clone(),
        tare_weight_kg: c.tare_g as f64 / 1000.0,
        is_active: c.is_active,
    }
}

fn kg2(kg: f64) -> f64 {
    (kg * 100.0).round() / 100.0
}

/// The number at the end of a bin's name ("Bin 077" -> 77).
fn trailing_number(name: &str) -> Option<u64> {
    let digits: String = name.trim_end().chars().rev().take_while(|c| c.is_ascii_digit()).collect::<String>().chars().rev().collect();
    if digits.is_empty() || digits.len() > 9 {
        None
    } else {
        digits.parse().ok()
    }
}

impl Default for SimServer {
    fn default() -> Self {
        Self::new()
    }
}

impl SimServer {
    pub fn new() -> Self {
        let mut carriers = Vec::new();
        let tares = [27_500, 27_250, 26_800, 28_100, 27_400, 27_900, 27_050, 28_400, 27_300, 27_600];
        for i in 1..=10 {
            carriers.push(CarrierInfo {
                id: format!("sim-carrier-{i:02}"),
                name: format!("Sim Bin {i}"),
                rfid_tag: Some(format!("00000001822257{:02}", 49 + i)),
                tare_g: tares[i - 1],
                is_active: true,
            });
        }
        // Edge cases the station must refuse to weigh.
        carriers.push(CarrierInfo {
            id: "sim-carrier-11".into(),
            name: "Sim Bin 11 (no tare)".into(),
            rfid_tag: Some("0000000182225760".into()),
            tare_g: 0,
            is_active: true,
        });
        carriers.push(CarrierInfo {
            id: "sim-carrier-12".into(),
            name: "Sim Bin 12 (inactive)".into(),
            rfid_tag: Some("0000000182225761".into()),
            tare_g: 27_000,
            is_active: false,
        });
        // Not yet registered: for the RFID registration workflow.
        for i in 13..=15 {
            carriers.push(CarrierInfo {
                id: format!("sim-carrier-{i:02}"),
                name: format!("Sim Bin {i}"),
                rfid_tag: None,
                tare_g: 27_200,
                is_active: true,
            });
        }
        Self::with_carriers(carriers)
    }

    /// The test server for hardware-test mode: the same in-process fake
    /// (assignment rule, pending window, registration checks), holding only
    /// the bins from `testCarriers`.
    pub fn with_carriers(carriers: Vec<CarrierInfo>) -> Self {
        let employees = ["Picker Alpha", "Picker Bravo", "Picker Charlie", "Picker Delta"]
            .iter()
            .enumerate()
            .map(|(i, n)| SimEmployee {
                id: format!("sim-employee-{}", i + 1),
                name: n.to_string(),
            })
            .collect();
        Self {
            inner: Mutex::new(Inner {
                carriers,
                employees,
                claims: vec![],
                weighings: vec![],
                sessions: HashMap::new(),
                registrations: vec![],
                conflicts: HashMap::new(),
                online: true,
                credits_enabled: true,
                next_id: 1,
            }),
        }
    }

    fn now() -> i64 {
        Utc::now().timestamp_millis()
    }

    #[cfg(test)]
    pub fn now_ms(&self) -> i64 {
        Self::now()
    }

    pub fn set_online(&self, online: bool) {
        self.inner.lock().unwrap().online = online;
    }

    pub fn set_credits_enabled(&self, on: bool) {
        self.inner.lock().unwrap().credits_enabled = on;
    }

    /// Applies the 24-hour rule as if `ms` had passed, once. There is no
    /// lasting clock offset: weighings and scans keep using the real clock,
    /// so new weighings aren't born expired and scan times stay comparable
    /// with station weighing times.
    pub fn expire_as_if(&self, ms: i64) {
        let mut g = self.inner.lock().unwrap();
        let now = Self::now() + ms;
        let carrier_ids: Vec<String> = g.carriers.iter().map(|c| c.id.clone()).collect();
        for id in carrier_ids {
            Self::reevaluate(&mut g, &id, now);
        }
    }

    /// A phone in the field switched `employee_id` to a bin; `timing` says
    /// when that happened. Arriving now models a late (offline) sync.
    /// Triggers re-evaluation, like the server's post-sync matching trigger.
    pub fn add_claim(&self, employee_id: &str, timing: ScanTiming, clock_trusted: bool) -> Result<String, String> {
        let mut g = self.inner.lock().unwrap();
        if !g.employees.iter().any(|e| e.id == employee_id) {
            return Err("unknown employee".into());
        }
        let now = Self::now();
        let (carrier_id, occurred_at) = match timing {
            ScanTiming::BeforeWeighing(wid) => {
                let w = g.weighings.iter().find(|w| w.facts.id == wid).ok_or("unknown weighing")?;
                let prev = Self::previous_of(&g, &w.facts.carrier_id, w.facts.weighed_at, &w.facts.id);
                // Halfway into the cycle, at most a minute before the weighing.
                let back = match prev {
                    Some(p) => ((w.facts.weighed_at - p) / 2).clamp(1, 60_000),
                    None => 60_000,
                };
                (w.facts.carrier_id.clone(), w.facts.weighed_at - back)
            }
            ScanTiming::Now(carrier) => (carrier, now),
            ScanTiming::MinutesAgo(carrier, m) => (carrier, now - m * 60_000),
        };
        if !g.carriers.iter().any(|c| c.id == carrier_id) {
            return Err("unknown carrier".into());
        }
        let id = format!("sim-claim-{}", g.next_id);
        g.next_id += 1;
        g.claims.push(Claim {
            id: id.clone(),
            employee_id: employee_id.into(),
            carrier_id: carrier_id.clone(),
            occurred_at,
            received_at: now,
            clock_trusted,
            consumed_by: None,
        });
        Self::reevaluate(&mut g, &carrier_id, now);
        Ok(id)
    }

    fn previous_of(g: &Inner, carrier_id: &str, at: i64, exclude: &str) -> Option<i64> {
        g.weighings
            .iter()
            .filter(|w| w.facts.carrier_id == carrier_id && w.facts.id != exclude && w.facts.weighed_at < at)
            .map(|w| w.facts.weighed_at)
            .max()
    }

    /// Re-runs the rule for every open weighing of a carrier, oldest first.
    fn reevaluate(g: &mut Inner, carrier_id: &str, now: i64) {
        let mut idx: Vec<usize> = (0..g.weighings.len()).filter(|&i| g.weighings[i].facts.carrier_id == carrier_id).collect();
        idx.sort_by_key(|&i| g.weighings[i].facts.weighed_at);
        for i in idx {
            let prev = Self::previous_of(g, carrier_id, g.weighings[i].facts.weighed_at, &g.weighings[i].facts.id.clone());
            g.weighings[i].facts.previous_weighed_at = prev;
            g.weighings[i].facts.current = Some(g.weighings[i].status);
            let d = decide(&g.weighings[i].facts, &g.claims, now);
            let wid = g.weighings[i].facts.id.clone();
            for c in g.claims.iter_mut().filter(|c| d.consume.contains(&c.id)) {
                c.consumed_by = Some(wid.clone());
            }
            for cid in &d.conflicts {
                g.conflicts.insert(cid.clone(), wid.clone());
            }
            g.weighings[i].status = d.status;
            g.weighings[i].facts.current_employee = if d.status == AssignmentStatus::Credited {
                d.employee_id.clone()
            } else {
                None
            };
        }
    }

    fn result_for(g: &Inner, id: &str) -> Option<AssignmentResult> {
        let w = g.weighings.iter().find(|w| w.facts.id == id)?;
        let employee_name = w
            .facts
            .current_employee
            .as_ref()
            .and_then(|e| g.employees.iter().find(|x| &x.id == e))
            .map(|e| e.name.clone());
        let pending_until = (w.status == AssignmentStatus::Pending).then(|| ms_to_rfc3339(w.facts.weighed_at + crate::matching::PENDING_RECOVERY_MS));
        Some(AssignmentResult {
            status: w.status.as_str().into(),
            employee_name,
            pending_until,
            // "Live" within the test only: nothing leaves this process.
            credits_live: Some(w.credits_live),
        })
    }

    pub fn carriers(&self) -> Vec<CarrierInfo> {
        self.inner.lock().unwrap().carriers.clone()
    }

    /// Current status of one weighing (re-evaluated first), or None if the
    /// server has never seen it.
    pub fn status(&self, id: &str) -> Option<AssignmentResult> {
        let mut g = self.inner.lock().unwrap();
        let carrier = g.weighings.iter().find(|w| w.facts.id == id)?.facts.carrier_id.clone();
        Self::reevaluate(&mut g, &carrier, Self::now());
        Self::result_for(&g, id)
    }

    /// Simulates a server-side administrator correction (a void on the
    /// Scale Weighings page) so tests can prove the station follows the server.
    #[cfg(test)]
    pub fn force_status(&self, id: &str, status: AssignmentStatus) {
        let mut g = self.inner.lock().unwrap();
        let w = g.weighings.iter_mut().find(|w| w.facts.id == id).unwrap();
        w.status = status;
        if status != AssignmentStatus::Credited {
            w.facts.current_employee = None;
        }
    }

    fn claim_state(g: &Inner, c: &Claim) -> (String, Option<String>) {
        if let Some(w) = &c.consumed_by {
            return ("used".into(), Some(w.clone()));
        }
        if let Some(w) = g.conflicts.get(&c.id) {
            return ("conflict".into(), Some(w.clone()));
        }
        if !c.clock_trusted {
            return ("clock_flagged".into(), None);
        }
        // The closed cycle this scan falls in, if any.
        let owner = g
            .weighings
            .iter()
            .filter(|w| w.facts.carrier_id == c.carrier_id && w.facts.weighed_at >= c.occurred_at)
            .min_by_key(|w| w.facts.weighed_at);
        match owner {
            None => ("waiting".into(), None),
            Some(w) if w.status == AssignmentStatus::Expired => ("cycle_discarded".into(), Some(w.facts.id.clone())),
            Some(w) => ("cycle_in_review".into(), Some(w.facts.id.clone())),
        }
    }

    pub fn world(&self) -> serde_json::Value {
        let g = self.inner.lock().unwrap();
        let name_of_carrier = |id: &str| g.carriers.iter().find(|c| c.id == id).map(|c| c.name.clone()).unwrap_or_default();
        let name_of_emp = |id: &str| g.employees.iter().find(|e| e.id == id).map(|e| e.name.clone()).unwrap_or_default();
        let claims: Vec<SimClaimView> = g
            .claims
            .iter()
            .rev()
            .take(30)
            .map(|c| {
                let (state, weighing_id) = Self::claim_state(&g, c);
                SimClaimView {
                    id: c.id.clone(),
                    employee_name: name_of_emp(&c.employee_id),
                    carrier_name: name_of_carrier(&c.carrier_id),
                    occurred_at: ms_to_rfc3339(c.occurred_at),
                    clock_trusted: c.clock_trusted,
                    consumed_by: c.consumed_by.clone(),
                    state,
                    weighing_id,
                }
            })
            .collect();
        let weighings: Vec<SimWeighingView> = g
            .weighings
            .iter()
            .rev()
            .take(30)
            .map(|w| SimWeighingView {
                id: w.facts.id.clone(),
                carrier_id: w.facts.carrier_id.clone(),
                carrier_name: name_of_carrier(&w.facts.carrier_id),
                weighed_at: ms_to_rfc3339(w.facts.weighed_at),
                status: w.status.as_str().into(),
                employee_name: w.facts.current_employee.as_deref().map(name_of_emp),
            })
            .collect();
        serde_json::json!({
            "carriers": g.carriers,
            "employees": g.employees,
            "claims": claims,
            "serverWeighings": weighings,
            "serverOnline": g.online,
            "creditsEnabled": g.credits_enabled,
            "unregisteredTag": UNREGISTERED_TAG,
            "logins": [
                { "email": "picker@sim.local", "pin": "1234", "role": "Employee" },
                { "email": "admin@sim.local", "pin": "1234", "role": "Administrator" }
            ],
        })
    }

    fn check_online(&self) -> Result<(), BackendError> {
        if self.inner.lock().unwrap().online {
            Ok(())
        } else {
            Err(BackendError::Offline("simulated network outage".into()))
        }
    }

    /// Any signed-in user may register bins (the server's rule).
    fn session(&self, s: &UserSession) -> Result<(), BackendError> {
        if self.inner.lock().unwrap().sessions.contains_key(&s.cookie) {
            Ok(())
        } else {
            Err(http(401, "Not authenticated"))
        }
    }

    fn same_as_expected(c: &CarrierInfo, e: &Expected) -> bool {
        c.rfid_tag == e.rfid_tag && kg2(c.tare_g as f64 / 1000.0) == kg2(e.tare_weight_kg)
    }

    fn stale(c: &CarrierInfo) -> BackendError {
        refused(
            409,
            "stale",
            format!("{} was changed while you were registering. Check its current tag and tare and try again.", c.name),
            serde_json::json!({ "current": reg_bin(c) }),
        )
    }
}

impl Backend for SimServer {
    fn fetch_carriers(&self) -> Result<Vec<CarrierInfo>, BackendError> {
        self.check_online()?;
        Ok(self.carriers())
    }

    fn submit_weighing(&self, w: &Weighing) -> Result<AssignmentResult, BackendError> {
        self.check_online()?;
        if !w.simulated {
            // Defense in depth: the simulator only ever accepts simulated rows.
            return Err(http(400, "simulator received a non-simulated weighing"));
        }
        let at = rfc3339_to_ms(&w.recorded_at).ok_or_else(|| http(400, "bad weighedAt"))?;
        let mut g = self.inner.lock().unwrap();
        if !g.carriers.iter().any(|c| c.id == w.carrier_id) {
            return Err(http(400, "Unknown carrier"));
        }
        // Idempotent on the station's UUID.
        if g.weighings.iter().all(|x| x.facts.id != w.id) {
            let credits_live = g.credits_enabled;
            g.weighings.push(SimWeighing {
                facts: WeighingFacts {
                    id: w.id.clone(),
                    carrier_id: w.carrier_id.clone(),
                    weighed_at: at,
                    previous_weighed_at: None,
                    current: None,
                    current_employee: None,
                },
                status: AssignmentStatus::Pending,
                credits_live,
            });
            Self::reevaluate(&mut g, &w.carrier_id, Self::now());
        }
        Ok(Self::result_for(&g, &w.id).unwrap())
    }

    fn weighing_statuses(&self, ids: &[String]) -> Result<HashMap<String, AssignmentResult>, BackendError> {
        self.check_online()?;
        Ok(ids.iter().filter_map(|id| self.status(id).map(|r| (id.clone(), r))).collect())
    }

    fn station_info(&self) -> Result<StationInfo, BackendError> {
        self.check_online()?;
        Ok(StationInfo {
            name: "Test station".into(),
            credits_enabled: self.inner.lock().unwrap().credits_enabled,
        })
    }

    fn user_login(&self, email: &str, pin: &str) -> Result<UserSession, BackendError> {
        self.check_online()?;
        let email = email.trim().to_lowercase();
        let (name, role) = match (email.as_str(), pin) {
            ("picker@sim.local", "1234") => ("Sim Picker", "Employee"),
            ("admin@sim.local", "1234") => ("Sim Admin", "Administrator"),
            ("manager@sim.local", "1234") => ("Sim Manager", "Manager"),
            _ => return Err(http(401, "Invalid email or PIN")),
        };
        let mut g = self.inner.lock().unwrap();
        let s = UserSession {
            cookie: format!("sim-session-{}", uuid::Uuid::new_v4()),
            refresh_cookie: None,
            name: name.into(),
            role: role.into(),
        };
        g.sessions.insert(s.cookie.clone(), s.clone());
        Ok(s)
    }

    fn user_logout(&self, s: &UserSession) {
        self.inner.lock().unwrap().sessions.remove(&s.cookie);
    }

    fn find_bins(&self, s: &UserSession, query: &str) -> Result<Vec<RegBin>, BackendError> {
        self.check_online()?;
        self.session(s)?;
        let q = query.trim().to_lowercase();
        if q.is_empty() {
            return Ok(vec![]);
        }
        let number: Option<u64> = (q.len() <= 9 && q.chars().all(|c| c.is_ascii_digit())).then(|| q.parse().unwrap());
        Ok(self
            .carriers()
            .iter()
            .filter(|c| c.is_active)
            .filter(|c| match number {
                Some(n) => trailing_number(&c.name) == Some(n),
                None => c.name.to_lowercase().contains(&q),
            })
            .map(reg_bin)
            .collect())
    }

    fn bin_for_tag(&self, s: &UserSession, tag: &str) -> Result<Option<RegBin>, BackendError> {
        self.check_online()?;
        self.session(s)?;
        let tag = normalize_rfid_tag(tag);
        Ok(self.carriers().iter().find(|c| c.rfid_tag.as_deref() == Some(tag.as_str())).map(reg_bin))
    }

    fn register_bin(&self, s: &UserSession, r: &RegistrationRequest) -> Result<RegistrationOutcome, BackendError> {
        self.check_online()?;
        self.session(s)?;
        let tag = normalize_rfid_tag(&r.rfid_tag);
        if tag.is_empty() || !is_valid_rfid_tag(&tag) {
            return Err(http(400, "No RFID tag was read. Every bin needs its tag."));
        }
        if r.measured.gross_kg < 2.0 || r.measured.status != "gross" || !r.empty_confirmed || kg2(r.tare_kg) != kg2(r.measured.gross_kg) {
            return Err(http(400, "The measurement or the empty-bin confirmation is missing."));
        }
        let tare_g = crate::backend::kg_to_g(kg2(r.tare_kg));
        let mut g = self.inner.lock().unwrap();
        let Some(ti) = g.carriers.iter().position(|c| c.id == r.carrier_id) else {
            return Err(refused(404, "binNotFound", "That bin doesn't exist in LabourLink.".into(), serde_json::Value::Null));
        };
        // A retried request is answered, never applied twice.
        if let Some(prev) = g.registrations.iter().find(|x| x.0 == r.registration_id) {
            if prev.1 != r.carrier_id {
                return Err(refused(409, "registrationIdReused", "This registration was already used for another bin.".into(), serde_json::Value::Null));
            }
            return Ok(RegistrationOutcome {
                carrier: reg_bin(&g.carriers[ti]),
                previous: None,
                moved_from: None,
                replay: true,
            });
        }
        let target = g.carriers[ti].clone();
        if !target.is_active {
            return Err(refused(409, "binInactive", format!("{} is inactive.", target.name), serde_json::Value::Null));
        }
        if !Self::same_as_expected(&target, &r.expected) {
            return Err(Self::stale(&target));
        }
        let holder = g.carriers.iter().position(|c| c.id != target.id && c.rfid_tag.as_deref() == Some(tag.as_str()));
        if let Some(hi) = holder {
            if r.move_from_carrier_id.as_deref() != Some(g.carriers[hi].id.as_str()) {
                let h = &g.carriers[hi];
                return Err(refused(
                    409,
                    "tagOnOtherBin",
                    format!("This tag is registered to {}. Move it only if {} was registered by mistake.", h.name, h.name),
                    serde_json::json!({ "holder": reg_bin(h) }),
                ));
            }
        } else if r.move_from_carrier_id.is_some() {
            return Err(Self::stale(&target));
        }
        let replaces_tag = target.rfid_tag.is_some() && target.rfid_tag.as_deref() != Some(tag.as_str());
        let replaces_tare = target.tare_g > 0 && target.tare_g != tare_g;
        if (replaces_tag || replaces_tare) && !r.confirm_overwrite {
            return Err(refused(
                409,
                "needsConfirmation",
                format!("{} already has a tag or tare. Confirm to replace.", target.name),
                serde_json::json!({ "current": reg_bin(&target), "replacesTag": replaces_tag, "replacesTare": replaces_tare }),
            ));
        }
        let mut moved_from = None;
        if let Some(hi) = holder {
            let h = g.carriers[hi].clone();
            // Restore the holder's previous tare if its last registration set this tag and tare.
            let last = g.registrations.iter().rev().find(|x| x.1 == h.id).cloned();
            let restore = match last {
                Some((_, _, _, old_tare, Some(new_tag), new_tare)) if new_tag == tag && new_tare == h.tare_g => old_tare,
                _ => h.tare_g,
            };
            g.carriers[hi].rfid_tag = None;
            g.carriers[hi].tare_g = restore;
            g.registrations.push((r.registration_id.clone(), h.id.clone(), h.rfid_tag.clone(), h.tare_g, None, restore));
            moved_from = Some(MovedFrom {
                id: h.id.clone(),
                name: h.name.clone(),
                tare_weight_kg: restore as f64 / 1000.0,
                tare_restored: restore != h.tare_g,
            });
        }
        g.carriers[ti].rfid_tag = Some(tag.clone());
        g.carriers[ti].tare_g = tare_g;
        g.registrations.push((r.registration_id.clone(), target.id.clone(), target.rfid_tag.clone(), target.tare_g, Some(tag), tare_g));
        Ok(RegistrationOutcome {
            carrier: reg_bin(&g.carriers[ti]),
            previous: Some(Expected {
                rfid_tag: target.rfid_tag.clone(),
                tare_weight_kg: target.tare_g as f64 / 1000.0,
            }),
            moved_from,
            replay: false,
        })
    }

    fn remove_tag(&self, s: &UserSession, r: &RemoveTagRequest) -> Result<RegistrationOutcome, BackendError> {
        self.check_online()?;
        self.session(s)?;
        if !r.confirm {
            return Err(http(400, "Confirm removing the tag."));
        }
        let mut g = self.inner.lock().unwrap();
        let Some(ti) = g.carriers.iter().position(|c| c.id == r.carrier_id) else {
            return Err(refused(404, "binNotFound", "That bin doesn't exist in LabourLink.".into(), serde_json::Value::Null));
        };
        let c = g.carriers[ti].clone();
        if !Self::same_as_expected(&c, &r.expected) {
            return Err(Self::stale(&c));
        }
        if c.rfid_tag.is_none() {
            return Err(refused(409, "noTag", format!("{} has no tag to remove.", c.name), serde_json::Value::Null));
        }
        g.carriers[ti].rfid_tag = None;
        g.registrations.push((r.registration_id.clone(), c.id.clone(), c.rfid_tag.clone(), c.tare_g, None, c.tare_g));
        Ok(RegistrationOutcome {
            carrier: reg_bin(&g.carriers[ti]),
            previous: Some(Expected {
                rfid_tag: c.rfid_tag.clone(),
                tare_weight_kg: c.tare_g as f64 / 1000.0,
            }),
            moved_from: None,
            replay: false,
        })
    }
}

// ---------------------------------------------------------------------------
// Simulated hardware

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RigFlags {
    pub wobble: bool,
    pub scale_offline: bool,
    pub rfid_offline: bool,
    pub rfid_repeat: bool,
    pub indicator_net: bool,
    pub overload: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RigView {
    pub flags: RigFlags,
    pub tag_on_scale: Option<String>,
    pub target_gross_g: i64,
}

struct RigState {
    flags: RigFlags,
    tag_on_scale: Option<String>,
    target_g: i64,
    current_g: f64,
    pending_tags: Vec<String>,
    last_tag_emit_ms: u64,
    seed: u64,
    scale_framer: ScaleFramer,
    rfid_framer: LineFramer,
}

pub struct SimRig {
    state: Mutex<RigState>,
}

/// One 100 ms step of simulated hardware output, already parsed.
pub struct RigOutput {
    pub reading: Option<Reading>,
    pub tags: Vec<String>,
}

impl Default for SimRig {
    fn default() -> Self {
        Self::new()
    }
}

impl SimRig {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(RigState {
                flags: RigFlags {
                    wobble: false,
                    scale_offline: false,
                    rfid_offline: false,
                    rfid_repeat: true,
                    indicator_net: false,
                    overload: false,
                },
                tag_on_scale: None,
                target_g: 0,
                current_g: 0.0,
                pending_tags: vec![],
                last_tag_emit_ms: 0,
                seed: 0x1234_5678,
                scale_framer: ScaleFramer::default(),
                rfid_framer: LineFramer::default(),
            }),
        }
    }

    pub fn view(&self) -> RigView {
        let s = self.state.lock().unwrap();
        RigView {
            flags: s.flags.clone(),
            tag_on_scale: s.tag_on_scale.clone(),
            target_gross_g: s.target_g,
        }
    }

    /// Puts a bin (or an untagged load when `tag` is None) on the scale.
    pub fn place(&self, tag: Option<String>, gross_g: i64) {
        let mut s = self.state.lock().unwrap();
        s.target_g = gross_g.max(0);
        if let Some(t) = &tag {
            s.pending_tags.push(t.clone());
        }
        s.tag_on_scale = tag;
    }

    pub fn remove(&self) {
        let mut s = self.state.lock().unwrap();
        s.target_g = 0;
        s.tag_on_scale = None;
    }

    /// A single extra read (a second bin passing the antenna).
    pub fn read_tag_once(&self, tag: String) {
        self.state.lock().unwrap().pending_tags.push(tag);
    }

    pub fn set_flags(&self, f: impl FnOnce(&mut RigFlags)) {
        f(&mut self.state.lock().unwrap().flags);
    }

    pub fn step(&self, now_ms: u64) -> RigOutput {
        let mut s = self.state.lock().unwrap();
        s.seed = s.seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let noise = ((s.seed >> 33) % 21) as f64 - 10.0; // ±10 g
        let diff = s.target_g as f64 - s.current_g;
        s.current_g += diff * 0.35;
        let mut motion = diff.abs() > 40.0;
        let mut shown = s.current_g;
        if s.flags.wobble && s.target_g > 0 {
            shown += ((now_ms as f64) / 180.0).sin() * 350.0;
            motion = true;
        } else if s.target_g > 0 {
            shown += noise;
        }
        // Indicator division assumed 10 g.
        let weight_g = ((shown / 10.0).round() as i64) * 10;
        let reading = Reading {
            weight_g: if s.flags.overload { None } else { Some(weight_g) },
            mode: if s.flags.indicator_net { IndicatorMode::Net } else { IndicatorMode::Gross },
            motion,
            overload: s.flags.overload,
            underload: false,
            error: false,
        };

        let mut out = RigOutput { reading: None, tags: vec![] };
        if !s.flags.scale_offline {
            // Through the real framer + parser, as if read from the port.
            let bytes = encode_rinstrum_auto_a(&reading);
            for frame in s.scale_framer.push(&bytes) {
                out.reading = crate::scale_proto::parse_frame(crate::scale_proto::ScaleProtocol::RinstrumAutoA, &frame);
            }
        }
        let mut lines = std::mem::take(&mut s.pending_tags);
        if s.flags.rfid_repeat && now_ms.saturating_sub(s.last_tag_emit_ms) >= 700 {
            if let Some(t) = s.tag_on_scale.clone() {
                lines.push(t);
            }
        }
        if !lines.is_empty() {
            s.last_tag_emit_ms = now_ms;
        }
        if !s.flags.rfid_offline {
            for t in lines {
                let raw = format!("R 0000 {t}\r\n");
                for line in s.rfid_framer.push(raw.as_bytes()) {
                    if let Some(r) = crate::rfid::parse_protagd_line(&line) {
                        out.tags.push(r.tag);
                    }
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sim_weighing(id: &str, carrier: &str, at_ms: i64) -> Weighing {
        Weighing {
            id: id.into(),
            carrier_id: carrier.into(),
            carrier_name: String::new(),
            rfid_tag: String::new(),
            gross_g: 60_000,
            tare_g: 27_500,
            net_g: 32_500,
            recorded_at: ms_to_rfc3339(at_ms),
            samples_g: vec![],
            simulated: true,
            upload_state: "queued".into(),
            upload_attempts: 0,
            last_error: None,
            assignment_status: "unknown".into(),
            employee_name: None,
            pending_until: None,
            credits_live: None,
        }
    }

    const MIN: i64 = 60_000;
    const BIN1: &str = "sim-carrier-01";
    const BIN2: &str = "sim-carrier-02";
    const ALPHA: &str = "sim-employee-1";
    const BRAVO: &str = "sim-employee-2";
    const CHARLIE: &str = "sim-employee-3";
    const DELTA: &str = "sim-employee-4";

    fn submit(s: &SimServer, id: &str, carrier: &str, at: i64) -> AssignmentResult {
        s.submit_weighing(&sim_weighing(id, carrier, at)).unwrap()
    }

    /// (status, employee name) as the server reports it now.
    fn st(s: &SimServer, id: &str) -> (String, Option<String>) {
        let r = s.status(id).unwrap();
        (r.status, r.employee_name)
    }

    fn credited(name: &str) -> (String, Option<String>) {
        ("credited".into(), Some(name.into()))
    }

    fn uncredited(status: &str) -> (String, Option<String>) {
        (status.into(), None)
    }

    fn claim_state(s: &SimServer, claim_id: &str) -> String {
        let world = s.world();
        let c = world["claims"].as_array().unwrap().iter().find(|c| c["id"] == claim_id).unwrap().clone();
        c["state"].as_str().unwrap().to_string()
    }

    #[test]
    fn bin1_bin2_bin1_each_cycle_is_credited_independently() {
        // The reported sequence: 1) Bin 1 weighed, 2) delayed scan credits Alpha,
        // 3) Bin 2 weighed, 4) delayed scan credits Bravo, 5) Bin 1 weighed again,
        // 6) a delayed scan for that second use credits a different picker.
        let s = SimServer::new();
        let t0 = s.now_ms() - 60 * MIN;
        assert_eq!(submit(&s, "W1", BIN1, t0).status, "pending");
        s.add_claim(ALPHA, ScanTiming::BeforeWeighing("W1".into()), true).unwrap();
        assert_eq!(st(&s, "W1"), credited("Picker Alpha"));

        assert_eq!(submit(&s, "W2", BIN2, t0 + 10 * MIN).status, "pending");
        s.add_claim(BRAVO, ScanTiming::BeforeWeighing("W2".into()), true).unwrap();
        assert_eq!(st(&s, "W2"), credited("Picker Bravo"));

        assert_eq!(
            submit(&s, "W3", BIN1, t0 + 20 * MIN).status,
            "pending",
            "an earlier credited use never blocks the next one"
        );
        s.add_claim(CHARLIE, ScanTiming::BeforeWeighing("W3".into()), true).unwrap();
        assert_eq!(st(&s, "W3"), credited("Picker Charlie"));

        // History is untouched.
        assert_eq!(st(&s, "W1"), credited("Picker Alpha"));
        assert_eq!(st(&s, "W2"), credited("Picker Bravo"));
    }

    #[test]
    fn a_late_conflicting_scan_never_changes_a_credit_and_is_flagged() {
        // What produced `Sim Bin 1: needs_review` in the report: a scan whose
        // time fell inside the FIRST Bin 1 cycle, after it was credited.
        let s = SimServer::new();
        let t0 = s.now_ms() - 60 * MIN;
        submit(&s, "W1", BIN1, t0);
        s.add_claim(ALPHA, ScanTiming::BeforeWeighing("W1".into()), true).unwrap();
        submit(&s, "W3", BIN1, t0 + 20 * MIN);
        let late = s.add_claim(DELTA, ScanTiming::MinutesAgo(BIN1.into(), 70), true).unwrap();
        assert_eq!(st(&s, "W1"), credited("Picker Alpha"));
        assert_eq!(st(&s, "W3"), uncredited("pending"), "a scan from cycle 1 can't credit cycle 2");
        assert_eq!(claim_state(&s, &late), "conflict");
        let world = s.world();
        assert!(world["serverWeighings"].as_array().unwrap().iter().all(|w| w["status"] != "needs_review"));
    }

    #[test]
    fn bin1_then_bin1_two_cycles_two_different_employees() {
        let s = SimServer::new();
        let t0 = s.now_ms() - 60 * MIN;
        submit(&s, "W1", BIN1, t0);
        s.add_claim(ALPHA, ScanTiming::BeforeWeighing("W1".into()), true).unwrap();
        submit(&s, "W2", BIN1, t0 + 10 * MIN); // emptied, reassigned, weighed again
        s.add_claim(BRAVO, ScanTiming::BeforeWeighing("W2".into()), true).unwrap();
        assert_eq!(st(&s, "W1"), credited("Picker Alpha"));
        assert_eq!(st(&s, "W2"), credited("Picker Bravo"));
    }

    #[test]
    fn the_same_employee_using_the_same_bin_twice_gets_two_credits() {
        let s = SimServer::new();
        let t0 = s.now_ms() - 60 * MIN;
        submit(&s, "W1", BIN1, t0);
        let c1 = s.add_claim(ALPHA, ScanTiming::BeforeWeighing("W1".into()), true).unwrap();
        submit(&s, "W2", BIN1, t0 + 10 * MIN);
        let c2 = s.add_claim(ALPHA, ScanTiming::BeforeWeighing("W2".into()), true).unwrap();
        assert_eq!(st(&s, "W1"), credited("Picker Alpha"));
        assert_eq!(st(&s, "W2"), credited("Picker Alpha"));
        assert_eq!((claim_state(&s, &c1), claim_state(&s, &c2)), ("used".to_string(), "used".to_string()));
    }

    #[test]
    fn a_scan_now_waits_for_the_bins_next_weighing() {
        let s = SimServer::new();
        let t0 = s.now_ms() - 60 * MIN;
        submit(&s, "W1", BIN1, t0);
        let c = s.add_claim(CHARLIE, ScanTiming::Now(BIN1.into()), true).unwrap();
        assert_eq!(st(&s, "W1"), uncredited("pending"), "a scan after a weighing is never credited to it");
        assert_eq!(claim_state(&s, &c), "waiting");
        submit(&s, "W2", BIN1, s.now_ms() + 1_000);
        assert_eq!(st(&s, "W2"), credited("Picker Charlie"));
        assert_eq!(st(&s, "W1"), uncredited("pending"));
    }

    #[test]
    fn two_pickers_in_one_cycle_need_review_and_earlier_credit_is_untouched() {
        let s = SimServer::new();
        let now = s.now_ms();
        submit(&s, "W1", BIN1, now - 60 * MIN);
        s.add_claim(ALPHA, ScanTiming::BeforeWeighing("W1".into()), true).unwrap();
        // Both pickers' phones synced scans of Bin 1 before its second weighing arrived.
        s.add_claim(BRAVO, ScanTiming::MinutesAgo(BIN1.into(), 30), true).unwrap();
        s.add_claim(CHARLIE, ScanTiming::MinutesAgo(BIN1.into(), 25), true).unwrap();
        submit(&s, "W2", BIN1, now - MIN);
        assert_eq!(st(&s, "W2"), uncredited("needs_review"));
        assert_eq!(st(&s, "W1"), credited("Picker Alpha"));
    }

    #[test]
    fn unassigned_weighing_expires_after_24h_is_discarded_and_cycles_stay_separate() {
        let s = SimServer::new();
        let t0 = s.now_ms() - 60 * MIN;
        submit(&s, "W1", BIN1, t0);
        s.add_claim(ALPHA, ScanTiming::BeforeWeighing("W1".into()), true).unwrap();
        let r = submit(&s, "W2", BIN1, t0 + 10 * MIN);
        assert!(r.pending_until.is_some());

        s.expire_as_if(24 * 60 * MIN);
        assert_eq!(st(&s, "W2"), uncredited("expired"));
        assert_eq!(st(&s, "W1"), credited("Picker Alpha"), "expiry never touches credits");

        // A scan for the discarded cycle arriving later revives nothing...
        let late = s.add_claim(BRAVO, ScanTiming::BeforeWeighing("W2".into()), true).unwrap();
        assert_eq!(st(&s, "W2"), uncredited("expired"));
        assert_eq!(claim_state(&s, &late), "cycle_discarded");
        // ...and doesn't leak into the bin's next use, which isn't born expired.
        assert_eq!(submit(&s, "W3", BIN1, s.now_ms()).status, "pending");
        assert_eq!(st(&s, "W3"), uncredited("pending"));
    }

    #[test]
    fn untrusted_phone_clock_never_credits() {
        let s = SimServer::new();
        submit(&s, "W1", BIN1, s.now_ms() - 60 * MIN);
        let c = s.add_claim(ALPHA, ScanTiming::BeforeWeighing("W1".into()), false).unwrap();
        assert_eq!(st(&s, "W1"), uncredited("pending"));
        assert_eq!(claim_state(&s, &c), "clock_flagged");
    }

    #[test]
    fn resend_is_idempotent_and_batch_status_omits_unknown_ids() {
        let s = SimServer::new();
        let t0 = s.now_ms() - 60 * MIN;
        s.add_claim(ALPHA, ScanTiming::MinutesAgo(BIN1.into(), 70), true).unwrap();
        let r = submit(&s, "W1", BIN1, t0);
        assert_eq!(r.employee_name.as_deref(), Some("Picker Alpha"));
        assert_eq!(submit(&s, "W1", BIN1, t0), r);
        let m = s.weighing_statuses(&["W1".into(), "never-sent".into()]).unwrap();
        assert_eq!(m.len(), 1);
        assert_eq!(m["W1"].status, "credited");
    }

    #[test]
    fn sim_server_refuses_real_weighings_and_obeys_outage() {
        let s = SimServer::new();
        let mut w = sim_weighing("w1", "sim-carrier-01", s.now_ms());
        w.simulated = false;
        assert!(matches!(s.submit_weighing(&w), Err(BackendError::Http { status: 400, .. })));
        s.set_online(false);
        assert!(matches!(s.fetch_carriers(), Err(BackendError::Offline(_))));
    }

    fn req(id: &str, carrier: &str, tag: &str, kg: f64, expected: Expected) -> RegistrationRequest {
        RegistrationRequest {
            registration_id: id.into(),
            carrier_id: carrier.into(),
            rfid_tag: tag.into(),
            tare_kg: kg,
            measured: crate::backend::Measured {
                gross_kg: kg,
                samples_kg: vec![kg; 6],
                status: "gross",
                stable_ms: 2000,
            },
            expected,
            empty_confirmed: true,
            confirm_overwrite: false,
            move_from_carrier_id: None,
        }
    }

    fn code(e: BackendError) -> String {
        match e {
            BackendError::Http { code, .. } => code.unwrap_or_default(),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn register_bins_follows_the_servers_rules() {
        let s = SimServer::new();
        assert!(matches!(s.user_login("picker@sim.local", "0000"), Err(BackendError::Http { status: 401, .. })));
        // Any signed-in user, not only administrators.
        let p = s.user_login(" Picker@Sim.Local", "1234").unwrap();
        assert_eq!(p.role, "Employee");
        let fresh = Expected {
            rfid_tag: None,
            tare_weight_kg: 27.2,
        };
        assert_eq!(s.find_bins(&p, "13").unwrap()[0].id, "sim-carrier-13");
        assert!(s.find_bins(&p, "12").unwrap().is_empty(), "inactive bins are not offered");

        // Replacing the existing 27.2 kg tare needs confirmation.
        let r1 = req("r1", "sim-carrier-13", "0000000000001313", 26.4, fresh.clone());
        assert_eq!(code(s.register_bin(&p, &r1).unwrap_err()), "needsConfirmation");
        let ok = s.register_bin(&p, &RegistrationRequest { confirm_overwrite: true, ..r1.clone() }).unwrap();
        assert_eq!((ok.carrier.rfid_tag.as_deref(), ok.carrier.tare_weight_kg), (Some("0000000000001313"), 26.4));
        assert!(s.register_bin(&p, &RegistrationRequest { confirm_overwrite: true, ..r1.clone() }).unwrap().replay);
        // A stale view is refused.
        assert_eq!(code(s.register_bin(&p, &req("r2", "sim-carrier-13", "0000000000001313", 26.4, fresh.clone())).unwrap_err()), "stale");

        // One tag, one bin; moving it off a bin registered by mistake restores that bin's tare.
        let r3 = req("r3", "sim-carrier-14", "0000000000001313", 26.4, fresh.clone());
        let e = s.register_bin(&p, &r3).unwrap_err();
        assert_eq!(code(e.clone()), "tagOnOtherBin");
        if let BackendError::Http { body, .. } = e {
            assert_eq!(body["holder"]["id"], "sim-carrier-13");
        }
        let moved = s
            .register_bin(
                &p,
                &RegistrationRequest {
                    move_from_carrier_id: Some("sim-carrier-13".into()),
                    confirm_overwrite: true,
                    ..r3
                },
            )
            .unwrap();
        let from = moved.moved_from.unwrap();
        assert!(from.tare_restored);
        assert_eq!(from.tare_weight_kg, 27.2);
        let bins = s.carriers();
        assert_eq!(bins.iter().find(|c| c.id == "sim-carrier-13").unwrap().rfid_tag, None);
        assert_eq!(bins.iter().filter(|c| c.rfid_tag.as_deref() == Some("0000000000001313")).count(), 1);

        // Removing a tag keeps the tare.
        let out = s
            .remove_tag(
                &p,
                &RemoveTagRequest {
                    registration_id: "r4".into(),
                    carrier_id: "sim-carrier-14".into(),
                    expected: Expected {
                        rfid_tag: Some("0000000000001313".into()),
                        tare_weight_kg: 26.4,
                    },
                    confirm: true,
                    reason: None,
                },
            )
            .unwrap();
        assert_eq!((out.carrier.rfid_tag, out.carrier.tare_weight_kg), (None, 26.4));

        // Signed out: refused.
        s.user_logout(&p);
        assert!(matches!(s.find_bins(&p, "13"), Err(BackendError::Http { status: 401, .. })));
    }

    #[test]
    fn rig_output_goes_through_parsers() {
        let rig = SimRig::new();
        rig.place(Some("0000000182225750".into()), 64_000);
        let mut t = 0;
        let mut tags = vec![];
        let mut last = None;
        for _ in 0..40 {
            let o = rig.step(t);
            tags.extend(o.tags);
            last = o.reading;
            t += 100;
        }
        assert!(tags.len() >= 4, "repeat reads every 700 ms: {}", tags.len());
        assert!(tags.iter().all(|t| t == "0000000182225750"));
        let r = last.unwrap();
        assert!((r.weight_g.unwrap() - 64_000).abs() <= 20);
        assert!(!r.motion);
        rig.set_flags(|f| f.scale_offline = true);
        assert!(rig.step(t).reading.is_none());
    }
}
