//! The station's view of the LabourLink server.
//!
//! Two implementations: `HttpBackend` (live) and `sim::SimServer`
//! (simulation, in-process, no network). The service picks one at startup
//! from the configured mode and never holds both, so a simulated weighing
//! has no code path to the real API.
//!
//! Station endpoints (`/api/scale/*`, authenticated with the station token)
//! are the contract proposed in docs/ARCHITECTURE.md and DO NOT EXIST on the
//! server yet. Admin RFID registration uses endpoints that already exist:
//! `POST /api/auth/login` (email + PIN, session cookie) and
//! `GET`/`PATCH /api/carriers[/:id]` (Administrator role, same validation
//! and duplicate-tag 409 as the Carriers page).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::time::Duration;

use crate::machine::CarrierInfo;
use crate::store::Weighing;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssignmentResult {
    pub status: String,
    pub employee_name: Option<String>,
    pub pending_until: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum BackendError {
    /// Network down, timeout, 5xx: retry later, keep the weighing queued.
    Offline(String),
    /// The server answered with a 4xx.
    Http {
        status: u16,
        message: String,
        errors: BTreeMap<String, String>,
    },
}

impl BackendError {
    pub fn message(&self) -> String {
        match self {
            BackendError::Offline(m) => m.clone(),
            BackendError::Http { message, errors, .. } => errors.values().next().cloned().unwrap_or_else(|| message.clone()),
        }
    }

    /// Auth/config problems are not the weighing's fault: keep retrying.
    pub fn is_permanent_rejection(&self) -> bool {
        matches!(self, BackendError::Http { status, .. } if *status != 401 && *status != 403 && *status != 408 && *status != 429)
    }
}

#[derive(Debug, Clone)]
pub struct AdminSession {
    pub cookie: String,
    pub name: String,
    pub role: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminCarrier {
    pub id: String,
    pub name: String,
    pub rfid_tag: Option<String>,
    pub tare_weight_kg: f64,
    pub is_active: bool,
}

pub trait Backend: Send + Sync {
    fn fetch_carriers(&self) -> Result<Vec<CarrierInfo>, BackendError>;
    fn submit_weighing(&self, w: &Weighing) -> Result<AssignmentResult, BackendError>;
    fn weighing_status(&self, id: &str) -> Result<AssignmentResult, BackendError>;
    fn admin_login(&self, email: &str, pin: &str) -> Result<AdminSession, BackendError>;
    fn admin_carriers(&self, session: &AdminSession, search: &str) -> Result<Vec<AdminCarrier>, BackendError>;
    fn admin_set_rfid(&self, session: &AdminSession, carrier_id: &str, rfid_tag: Option<&str>) -> Result<AdminCarrier, BackendError>;
}

pub fn kg_to_g(kg: f64) -> i64 {
    (kg * 1000.0).round() as i64
}

/// Body of `POST /api/scale/weighings` (proposed contract). Weights are
/// integer grams so nothing is lost to float rounding in transit.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeighingUpload<'a> {
    pub station_weighing_id: &'a str,
    pub carrier_id: &'a str,
    pub rfid_tag: &'a str,
    pub gross_g: i64,
    pub tare_g: i64,
    pub net_g: i64,
    pub weighed_at: &'a str,
    pub samples_g: &'a [i64],
}

impl<'a> From<&'a Weighing> for WeighingUpload<'a> {
    fn from(w: &'a Weighing) -> Self {
        WeighingUpload {
            station_weighing_id: &w.id,
            carrier_id: &w.carrier_id,
            rfid_tag: &w.rfid_tag,
            gross_g: w.gross_g,
            tare_g: w.tare_g,
            net_g: w.net_g,
            weighed_at: &w.recorded_at,
            samples_g: &w.samples_g,
        }
    }
}

pub struct HttpBackend {
    base: String,
    station_token: Option<String>,
    agent: ureq::Agent,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScaleCarrier {
    id: String,
    name: String,
    rfid_tag: Option<String>,
    tare_weight_kg: f64,
    is_active: bool,
}

#[derive(Deserialize, Default)]
struct ErrorBody {
    error: Option<String>,
    #[serde(default)]
    errors: BTreeMap<String, String>,
}

fn map_err(e: ureq::Error) -> BackendError {
    match e {
        ureq::Error::Status(status, resp) if status < 500 => {
            let body: ErrorBody = resp.into_json().unwrap_or_default();
            BackendError::Http {
                status,
                message: body.error.unwrap_or_else(|| format!("HTTP {status}")),
                errors: body.errors,
            }
        }
        ureq::Error::Status(status, _) => BackendError::Offline(format!("server error HTTP {status}")),
        ureq::Error::Transport(t) => BackendError::Offline(t.to_string()),
    }
}

fn json<T: serde::de::DeserializeOwned>(r: ureq::Response) -> Result<T, BackendError> {
    r.into_json().map_err(|e| BackendError::Offline(format!("bad response: {e}")))
}

impl HttpBackend {
    pub fn new(base: &str, station_token: Option<String>) -> Self {
        let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(10)).build();
        Self {
            base: base.trim_end_matches('/').to_string(),
            station_token,
            agent,
        }
    }

    fn station(&self, req: ureq::Request) -> Result<ureq::Request, BackendError> {
        let token = self
            .station_token
            .as_deref()
            .ok_or_else(|| BackendError::Offline("station token file missing".into()))?;
        Ok(req.set("Authorization", &format!("Bearer {token}")))
    }

    fn admin(&self, req: ureq::Request, s: &AdminSession) -> ureq::Request {
        req.set("Cookie", &format!("labourlink_session={}", s.cookie))
    }
}

pub fn session_cookie_from(set_cookies: &[&str]) -> Option<String> {
    set_cookies.iter().find_map(|h| {
        let first = h.split(';').next()?.trim();
        let value = first.strip_prefix("labourlink_session=")?;
        (!value.is_empty()).then(|| value.to_string())
    })
}

impl Backend for HttpBackend {
    fn fetch_carriers(&self) -> Result<Vec<CarrierInfo>, BackendError> {
        #[derive(Deserialize)]
        struct R {
            carriers: Vec<ScaleCarrier>,
        }
        let r: R = json(
            self.station(self.agent.get(&format!("{}/api/scale/carriers", self.base)))?
                .call()
                .map_err(map_err)?,
        )?;
        Ok(r.carriers
            .into_iter()
            .map(|c| CarrierInfo {
                id: c.id,
                name: c.name,
                rfid_tag: c.rfid_tag,
                tare_g: kg_to_g(c.tare_weight_kg),
                is_active: c.is_active,
            })
            .collect())
    }

    fn submit_weighing(&self, w: &Weighing) -> Result<AssignmentResult, BackendError> {
        let req = self.station(self.agent.post(&format!("{}/api/scale/weighings", self.base)))?;
        json(req.send_json(serde_json::to_value(WeighingUpload::from(w)).unwrap()).map_err(map_err)?)
    }

    fn weighing_status(&self, id: &str) -> Result<AssignmentResult, BackendError> {
        json(
            self.station(self.agent.get(&format!("{}/api/scale/weighings/{id}", self.base)))?
                .call()
                .map_err(map_err)?,
        )
    }

    fn admin_login(&self, email: &str, pin: &str) -> Result<AdminSession, BackendError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Emp {
            first_name: String,
            last_name: String,
            security_role: String,
        }
        #[derive(Deserialize)]
        struct R {
            employee: Emp,
        }
        let resp = self
            .agent
            .post(&format!("{}/api/auth/login", self.base))
            .send_json(serde_json::json!({ "email": email, "pin": pin }))
            .map_err(map_err)?;
        let cookie = session_cookie_from(&resp.all("set-cookie")).ok_or_else(|| BackendError::Offline("login response had no session cookie".into()))?;
        let r: R = json(resp)?;
        Ok(AdminSession {
            cookie,
            name: format!("{} {}", r.employee.first_name, r.employee.last_name),
            role: r.employee.security_role,
        })
    }

    fn admin_carriers(&self, s: &AdminSession, search: &str) -> Result<Vec<AdminCarrier>, BackendError> {
        #[derive(Deserialize)]
        struct R {
            carriers: Vec<AdminCarrier>,
        }
        let req = self
            .admin(self.agent.get(&format!("{}/api/carriers", self.base)), s)
            .query("status", "all")
            .query("search", search);
        Ok(json::<R>(req.call().map_err(map_err)?)?.carriers)
    }

    fn admin_set_rfid(&self, s: &AdminSession, carrier_id: &str, rfid_tag: Option<&str>) -> Result<AdminCarrier, BackendError> {
        #[derive(Deserialize)]
        struct R {
            carrier: AdminCarrier,
        }
        // Only rfidTag is sent: PATCH leaves every other carrier field untouched.
        let req = self.admin(self.agent.request("PATCH", &format!("{}/api/carriers/{carrier_id}", self.base)), s);
        Ok(json::<R>(req.send_json(serde_json::json!({ "rfidTag": rfid_tag })).map_err(map_err)?)?.carrier)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_the_session_cookie_from_set_cookie_headers() {
        let headers = ["other=1; Path=/", "labourlink_session=abc.def.ghi; Path=/; HttpOnly; Secure; SameSite=None"];
        assert_eq!(session_cookie_from(&headers).as_deref(), Some("abc.def.ghi"));
        assert_eq!(session_cookie_from(&["labourlink_session=; Max-Age=0"]), None);
    }

    #[test]
    fn rejection_classification() {
        let http = |status| BackendError::Http {
            status,
            message: String::new(),
            errors: BTreeMap::new(),
        };
        assert!(http(400).is_permanent_rejection());
        assert!(http(409).is_permanent_rejection());
        assert!(!http(401).is_permanent_rejection());
        assert!(!http(403).is_permanent_rejection());
        assert!(!BackendError::Offline("x".into()).is_permanent_rejection());
    }

    #[test]
    fn upload_body_uses_integer_grams_and_station_id() {
        let w = Weighing {
            id: "u-1".into(),
            carrier_id: "c-a".into(),
            carrier_name: "Bin 23".into(),
            rfid_tag: "0000000182225750".into(),
            gross_g: 64_380,
            tare_g: 27_500,
            net_g: 36_880,
            recorded_at: "2026-10-27T10:00:00.000Z".into(),
            samples_g: vec![64_380],
            simulated: false,
            upload_state: "queued".into(),
            upload_attempts: 0,
            last_error: None,
            assignment_status: "unknown".into(),
            employee_name: None,
            pending_until: None,
        };
        let v = serde_json::to_value(WeighingUpload::from(&w)).unwrap();
        assert_eq!(v["stationWeighingId"], "u-1");
        assert_eq!(v["netG"], 36_880);
        assert_eq!(v["rfidTag"], "0000000182225750");
        assert!(
            v.get("simulated").is_none(),
            "the live contract has no simulated flag: simulated rows never reach it"
        );
    }
}
