//! Simulation mode: a fake LabourLink server and fake hardware.
//!
//! Nothing here touches the network. `SimServer` implements `Backend` in
//! memory with clearly fake bins and pickers, runs the reference assignment
//! rule (matching.rs) and mirrors the real Carriers API's RFID validation
//! and duplicate-tag message. `SimRig` produces indicator frames and RFID
//! lines as raw bytes that go through the same framers and parsers as the
//! serial ports, so the parsing path is exercised too.

use chrono::{DateTime, Utc};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;

use crate::backend::{AdminCarrier, AdminSession, AssignmentResult, Backend, BackendError};
use crate::machine::CarrierInfo;
use crate::matching::{decide, AssignmentStatus, Claim, WeighingFacts};
use crate::rfid::{is_valid_rfid_tag, normalize_rfid_tag, LineFramer, MAX_RFID_TAG_LENGTH};
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
}

struct Inner {
    carriers: Vec<CarrierInfo>,
    employees: Vec<SimEmployee>,
    claims: Vec<Claim>,
    weighings: Vec<SimWeighing>,
    sessions: HashMap<String, AdminSession>,
    /// claim id -> credited weighing id it conflicts with (flag only).
    conflicts: HashMap<String, String>,
    online: bool,
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
    BackendError::Http {
        status,
        message: message.into(),
        errors: BTreeMap::new(),
    }
}

fn field(status: u16, field: &str, message: String) -> BackendError {
    BackendError::Http {
        status,
        message: "Validation failed".into(),
        errors: BTreeMap::from([(field.to_string(), message)]),
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
                conflicts: HashMap::new(),
                online: true,
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

    /// Simulates a future, explicit and audited administrator correction
    /// (not built yet) so tests can prove the station follows the server.
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
            "unregisteredTag": UNREGISTERED_TAG,
            "adminLogins": [
                { "email": "admin@sim.local", "pin": "1234", "role": "Administrator" },
                { "email": "manager@sim.local", "pin": "1234", "role": "Manager" }
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

    fn session(&self, s: &AdminSession, roles: &[&str]) -> Result<(), BackendError> {
        let g = self.inner.lock().unwrap();
        let Some(live) = g.sessions.get(&s.cookie) else {
            return Err(http(401, "Not authenticated"));
        };
        if !roles.contains(&live.role.as_str()) {
            return Err(http(403, "Insufficient permissions"));
        }
        Ok(())
    }

    fn admin_view(c: &CarrierInfo) -> AdminCarrier {
        AdminCarrier {
            id: c.id.clone(),
            name: c.name.clone(),
            rfid_tag: c.rfid_tag.clone(),
            tare_weight_kg: c.tare_g as f64 / 1000.0,
            is_active: c.is_active,
        }
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
            });
            Self::reevaluate(&mut g, &w.carrier_id, Self::now());
        }
        Ok(Self::result_for(&g, &w.id).unwrap())
    }

    fn weighing_statuses(&self, ids: &[String]) -> Result<HashMap<String, AssignmentResult>, BackendError> {
        self.check_online()?;
        Ok(ids.iter().filter_map(|id| self.status(id).map(|r| (id.clone(), r))).collect())
    }

    fn admin_login(&self, email: &str, pin: &str) -> Result<AdminSession, BackendError> {
        self.check_online()?;
        let email = email.trim().to_lowercase();
        let (name, role) = match (email.as_str(), pin) {
            ("admin@sim.local", "1234") => ("Sim Admin", "Administrator"),
            ("manager@sim.local", "1234") => ("Sim Manager", "Manager"),
            _ => return Err(http(401, "Invalid email or PIN")),
        };
        let mut g = self.inner.lock().unwrap();
        let s = AdminSession {
            cookie: format!("sim-session-{}", uuid::Uuid::new_v4()),
            name: name.into(),
            role: role.into(),
        };
        g.sessions.insert(s.cookie.clone(), s.clone());
        Ok(s)
    }

    fn admin_carriers(&self, s: &AdminSession, search: &str) -> Result<Vec<AdminCarrier>, BackendError> {
        self.check_online()?;
        self.session(s, &["Administrator", "Manager"])?;
        let q = search.trim().to_lowercase();
        let qt = normalize_rfid_tag(search);
        Ok(self
            .carriers()
            .iter()
            .filter(|c| q.is_empty() || c.name.to_lowercase().contains(&q) || c.rfid_tag.as_deref().is_some_and(|t| t.contains(&qt)))
            .map(Self::admin_view)
            .collect())
    }

    fn admin_set_rfid(&self, s: &AdminSession, carrier_id: &str, rfid_tag: Option<&str>) -> Result<AdminCarrier, BackendError> {
        self.check_online()?;
        self.session(s, &["Administrator"])?;
        // Same rule and messages as server/src/lib/rfidTag.ts + carriers.ts.
        let tag = match rfid_tag.map(normalize_rfid_tag) {
            None => None,
            Some(t) if t.is_empty() => None,
            Some(t) if t.len() > MAX_RFID_TAG_LENGTH => {
                return Err(field(400, "rfidTag", format!("RFID tag must be {MAX_RFID_TAG_LENGTH} characters or fewer")))
            }
            Some(t) if !is_valid_rfid_tag(&t) => return Err(field(400, "rfidTag", "RFID tag may only contain letters and digits".into())),
            Some(t) => Some(t),
        };
        let mut g = self.inner.lock().unwrap();
        if let Some(t) = &tag {
            if let Some(owner) = g.carriers.iter().find(|c| c.id != carrier_id && c.rfid_tag.as_deref() == Some(t)) {
                return Err(field(
                    409,
                    "rfidTag",
                    format!("RFID tag {t} is already assigned to \"{}\". Clear it there first.", owner.name),
                ));
            }
        }
        let c = g
            .carriers
            .iter_mut()
            .find(|c| c.id == carrier_id)
            .ok_or_else(|| http(404, "Carrier not found"))?;
        c.rfid_tag = tag;
        Ok(Self::admin_view(c))
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

    #[test]
    fn rfid_registration_mirrors_carriers_api_rules() {
        let s = SimServer::new();
        let mgr = s.admin_login("manager@sim.local", "1234").unwrap();
        assert!(matches!(
            s.admin_set_rfid(&mgr, "sim-carrier-13", Some("1")),
            Err(BackendError::Http { status: 403, .. })
        ));
        assert!(matches!(s.admin_login("admin@sim.local", "0000"), Err(BackendError::Http { status: 401, .. })));
        let admin = s.admin_login("Admin@Sim.Local ", "1234").unwrap();
        let c = s.admin_set_rfid(&admin, "sim-carrier-13", Some(" 0000 0001 2345 ")).unwrap();
        assert_eq!(c.rfid_tag.as_deref(), Some("000000012345"));
        let err = s.admin_set_rfid(&admin, "sim-carrier-14", Some("0000000182225750")).unwrap_err();
        assert_eq!(
            err.message(),
            "RFID tag 0000000182225750 is already assigned to \"Sim Bin 1\". Clear it there first."
        );
        assert!(matches!(
            s.admin_set_rfid(&admin, "sim-carrier-14", Some("AB-12")),
            Err(BackendError::Http { status: 400, .. })
        ));
        assert_eq!(s.admin_set_rfid(&admin, "sim-carrier-13", None).unwrap().rfid_tag, None);
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
