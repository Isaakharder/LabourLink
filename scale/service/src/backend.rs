//! The station's view of the LabourLink server.
//!
//! Two implementations: `HttpBackend` (live) and `sim::SimServer`
//! (simulation and hardware test, in-process, no network). The service picks
//! one at startup from the configured mode and never holds both, so a test
//! weighing has no code path to the real API.
//!
//! Station endpoints (`/api/scale/*`) are authenticated with the station's
//! own token (server/src/routes/scale.ts). Register Bins also needs a
//! signed-in LabourLink user, any role: the person signs in with their own
//! email and PIN (`POST /api/auth/login`), and every registration request
//! carries both the station token and that person's session, so the server's
//! audit trail records who did it and where.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::time::Duration;

use crate::machine::CarrierInfo;
use crate::store::Weighing;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssignmentResult {
    pub status: String,
    pub employee_name: Option<String>,
    pub pending_until: Option<String>,
    /// False while the station's credits are off (trial): the server matched
    /// the weighing but it never counts as an employee credit.
    #[serde(default)]
    pub credits_live: Option<bool>,
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
        /// Machine-readable reason, e.g. "needsConfirmation" or "tagOnOtherBin".
        code: Option<String>,
        /// The whole response body, for refusals that carry data (the bin
        /// that already holds a tag, the bin's current tag and tare).
        body: serde_json::Value,
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

    pub fn http(status: u16, message: impl Into<String>) -> Self {
        BackendError::Http {
            status,
            message: message.into(),
            errors: BTreeMap::new(),
            code: None,
            body: serde_json::Value::Null,
        }
    }
}

/// A signed-in LabourLink user at the station (Register Bins). Held only in
/// the service's memory; the PIN is never stored.
#[derive(Debug, Clone)]
pub struct UserSession {
    /// `labourlink_session` (short-lived access token).
    pub cookie: String,
    /// `labourlink_refresh`, so the server can renew the access token and
    /// sign-out can revoke the session.
    pub refresh_cookie: Option<String>,
    pub name: String,
    pub role: String,
}

/// An existing LabourLink bin as Register Bins sees it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegBin {
    pub id: String,
    pub name: String,
    pub rfid_tag: Option<String>,
    pub tare_weight_kg: f64,
    pub is_active: bool,
}

/// What the person saw for the bin before confirming. The server refuses
/// the registration if the bin has changed since (two people at once).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Expected {
    pub rfid_tag: Option<String>,
    pub tare_weight_kg: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Measured {
    pub gross_kg: f64,
    pub samples_kg: Vec<f64>,
    /// Always "gross": registration is refused in any other indicator mode.
    pub status: &'static str,
    pub stable_ms: u64,
}

/// Body of `POST /api/scale/registration`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationRequest {
    /// One id per measured proposal, so a retried request is applied once.
    pub registration_id: String,
    pub carrier_id: String,
    pub rfid_tag: String,
    pub tare_kg: f64,
    pub measured: Measured,
    pub expected: Expected,
    pub empty_confirmed: bool,
    pub confirm_overwrite: bool,
    pub move_from_carrier_id: Option<String>,
}

/// Body of `POST /api/scale/registration/remove-tag`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveTagRequest {
    pub registration_id: String,
    pub carrier_id: String,
    pub expected: Expected,
    pub confirm: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MovedFrom {
    pub id: String,
    pub name: String,
    pub tare_weight_kg: f64,
    pub tare_restored: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationOutcome {
    pub carrier: RegBin,
    #[serde(default)]
    pub previous: Option<Expected>,
    #[serde(default)]
    pub moved_from: Option<MovedFrom>,
    #[serde(default)]
    pub replay: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StationInfo {
    pub name: String,
    pub credits_enabled: bool,
}

pub trait Backend: Send + Sync {
    fn fetch_carriers(&self) -> Result<Vec<CarrierInfo>, BackendError>;
    fn submit_weighing(&self, w: &Weighing) -> Result<AssignmentResult, BackendError>;
    /// Server's current status for each weighing it knows. Ids it has never
    /// seen are absent from the map (the station then re-sends them).
    fn weighing_statuses(&self, ids: &[String]) -> Result<HashMap<String, AssignmentResult>, BackendError>;
    /// The station's own record on the server: whether its credits are live.
    fn station_info(&self) -> Result<StationInfo, BackendError>;
    fn user_login(&self, email: &str, pin: &str) -> Result<UserSession, BackendError>;
    /// Ends the session on the server too. Best effort.
    fn user_logout(&self, session: &UserSession);
    fn find_bins(&self, session: &UserSession, query: &str) -> Result<Vec<RegBin>, BackendError>;
    fn bin_for_tag(&self, session: &UserSession, tag: &str) -> Result<Option<RegBin>, BackendError>;
    fn register_bin(&self, session: &UserSession, req: &RegistrationRequest) -> Result<RegistrationOutcome, BackendError>;
    fn remove_tag(&self, session: &UserSession, req: &RemoveTagRequest) -> Result<RegistrationOutcome, BackendError>;
}

/// Assignment statuses the station understands. Anything else the server
/// reports is stored as "unknown", which the display never shows as credited.
pub fn normalize_status(s: &str) -> &'static str {
    match s {
        "credited" => "credited",
        "pending" => "pending",
        "needs_review" => "needs_review",
        "expired" => "expired",
        "voided" => "voided",
        _ => "unknown",
    }
}

pub fn kg_to_g(kg: f64) -> i64 {
    (kg * 1000.0).round() as i64
}

pub fn g_to_kg(g: i64) -> f64 {
    (g as f64) / 1000.0
}

/// Body of `POST /api/scale/weighings`. Weights are integer grams so
/// nothing is lost to float rounding in transit.
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

fn map_err(e: ureq::Error) -> BackendError {
    match e {
        ureq::Error::Status(status, resp) if status < 500 => {
            let body: serde_json::Value = resp.into_json().unwrap_or(serde_json::Value::Null);
            let errors: BTreeMap<String, String> = body
                .get("errors")
                .and_then(|e| e.as_object())
                .map(|o| o.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect())
                .unwrap_or_default();
            BackendError::Http {
                status,
                message: body.get("error").and_then(|e| e.as_str()).map(str::to_string).unwrap_or_else(|| format!("HTTP {status}")),
                errors,
                code: body.get("code").and_then(|c| c.as_str()).map(str::to_string),
                body,
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

    /// Station token + the signed-in person's session.
    fn person(&self, req: ureq::Request, s: &UserSession) -> Result<ureq::Request, BackendError> {
        Ok(self.station(req)?.set("Cookie", &cookie_header(s)))
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }
}

pub fn cookie_header(s: &UserSession) -> String {
    match &s.refresh_cookie {
        Some(r) => format!("labourlink_session={}; labourlink_refresh={r}", s.cookie),
        None => format!("labourlink_session={}", s.cookie),
    }
}

fn cookie_from(set_cookies: &[&str], name: &str) -> Option<String> {
    let prefix = format!("{name}=");
    set_cookies.iter().find_map(|h| {
        let first = h.split(';').next()?.trim();
        let value = first.strip_prefix(&prefix)?;
        (!value.is_empty()).then(|| value.to_string())
    })
}

pub fn session_cookie_from(set_cookies: &[&str]) -> Option<String> {
    cookie_from(set_cookies, "labourlink_session")
}

/// Percent-encodes a query value (letters, digits and -._~ pass through).
fn encode_query(v: &str) -> String {
    v.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

impl Backend for HttpBackend {
    fn fetch_carriers(&self) -> Result<Vec<CarrierInfo>, BackendError> {
        #[derive(Deserialize)]
        struct R {
            carriers: Vec<ScaleCarrier>,
        }
        let r: R = json(self.station(self.agent.get(&self.url("/api/scale/carriers")))?.call().map_err(map_err)?)?;
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
        let req = self.station(self.agent.post(&self.url("/api/scale/weighings")))?;
        json(req.send_json(serde_json::to_value(WeighingUpload::from(w)).unwrap()).map_err(map_err)?)
    }

    fn weighing_statuses(&self, ids: &[String]) -> Result<HashMap<String, AssignmentResult>, BackendError> {
        #[derive(Deserialize)]
        struct R {
            statuses: HashMap<String, AssignmentResult>,
        }
        let req = self.station(self.agent.post(&self.url("/api/scale/weighings/status")))?;
        Ok(json::<R>(req.send_json(serde_json::json!({ "ids": ids })).map_err(map_err)?)?.statuses)
    }

    fn station_info(&self) -> Result<StationInfo, BackendError> {
        #[derive(Deserialize)]
        struct R {
            station: StationInfo,
        }
        Ok(json::<R>(self.station(self.agent.get(&self.url("/api/scale/station")))?.call().map_err(map_err)?)?.station)
    }

    fn user_login(&self, email: &str, pin: &str) -> Result<UserSession, BackendError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Emp {
            first_name: String,
            last_name: Option<String>,
            security_role: String,
        }
        #[derive(Deserialize)]
        struct R {
            employee: Emp,
        }
        let resp = self
            .agent
            .post(&self.url("/api/auth/login"))
            .send_json(serde_json::json!({ "email": email, "pin": pin }))
            .map_err(map_err)?;
        let set_cookies = resp.all("set-cookie");
        let cookie = session_cookie_from(&set_cookies).ok_or_else(|| BackendError::Offline("login response had no session cookie".into()))?;
        let refresh_cookie = cookie_from(&set_cookies, "labourlink_refresh");
        let r: R = json(resp)?;
        Ok(UserSession {
            cookie,
            refresh_cookie,
            name: format!("{} {}", r.employee.first_name, r.employee.last_name.unwrap_or_default()).trim().to_string(),
            role: r.employee.security_role,
        })
    }

    fn user_logout(&self, s: &UserSession) {
        let _ = self.agent.post(&self.url("/api/auth/logout")).set("Cookie", &cookie_header(s)).send_json(serde_json::json!({}));
    }

    fn find_bins(&self, s: &UserSession, query: &str) -> Result<Vec<RegBin>, BackendError> {
        #[derive(Deserialize)]
        struct R {
            bins: Vec<RegBin>,
        }
        let req = self.person(self.agent.get(&self.url(&format!("/api/scale/registration/bins?q={}", encode_query(query)))), s)?;
        Ok(json::<R>(req.call().map_err(map_err)?)?.bins)
    }

    fn bin_for_tag(&self, s: &UserSession, tag: &str) -> Result<Option<RegBin>, BackendError> {
        #[derive(Deserialize)]
        struct R {
            bin: Option<RegBin>,
        }
        let req = self.person(self.agent.get(&self.url(&format!("/api/scale/registration/tags/{}", encode_query(tag)))), s)?;
        Ok(json::<R>(req.call().map_err(map_err)?)?.bin)
    }

    fn register_bin(&self, s: &UserSession, body: &RegistrationRequest) -> Result<RegistrationOutcome, BackendError> {
        let req = self.person(self.agent.post(&self.url("/api/scale/registration")), s)?;
        json(req.send_json(serde_json::to_value(body).unwrap()).map_err(map_err)?)
    }

    fn remove_tag(&self, s: &UserSession, body: &RemoveTagRequest) -> Result<RegistrationOutcome, BackendError> {
        let req = self.person(self.agent.post(&self.url("/api/scale/registration/remove-tag")), s)?;
        json(req.send_json(serde_json::to_value(body).unwrap()).map_err(map_err)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_the_session_and_refresh_cookies_from_set_cookie_headers() {
        let headers = [
            "other=1; Path=/",
            "labourlink_session=abc.def.ghi; Path=/; HttpOnly; Secure; SameSite=None",
            "labourlink_refresh=r-123; Path=/api; HttpOnly",
        ];
        assert_eq!(session_cookie_from(&headers).as_deref(), Some("abc.def.ghi"));
        assert_eq!(cookie_from(&headers, "labourlink_refresh").as_deref(), Some("r-123"));
        assert_eq!(session_cookie_from(&["labourlink_session=; Max-Age=0"]), None);
        let s = UserSession {
            cookie: "abc".into(),
            refresh_cookie: Some("r-123".into()),
            name: "Pia".into(),
            role: "Employee".into(),
        };
        assert_eq!(cookie_header(&s), "labourlink_session=abc; labourlink_refresh=r-123");
    }

    #[test]
    fn rejection_classification() {
        let http = |status| BackendError::http(status, "");
        assert!(http(400).is_permanent_rejection());
        assert!(http(409).is_permanent_rejection());
        assert!(http(422).is_permanent_rejection());
        assert!(!http(401).is_permanent_rejection());
        assert!(!http(403).is_permanent_rejection());
        assert!(!BackendError::Offline("x".into()).is_permanent_rejection());
    }

    #[test]
    fn query_values_are_percent_encoded() {
        assert_eq!(encode_query("Bin 77"), "Bin%2077");
        assert_eq!(encode_query("a&b=c"), "a%26b%3Dc");
        assert_eq!(encode_query("0000000182225750"), "0000000182225750");
    }

    #[test]
    fn registration_body_matches_the_server_contract() {
        let r = RegistrationRequest {
            registration_id: "r-1".into(),
            carrier_id: "c-77".into(),
            rfid_tag: "0000000182225750".into(),
            tare_kg: 154.4,
            measured: Measured {
                gross_kg: 154.4,
                samples_kg: vec![154.4, 154.4],
                status: "gross",
                stable_ms: 2000,
            },
            expected: Expected {
                rfid_tag: None,
                tare_weight_kg: 0.0,
            },
            empty_confirmed: true,
            confirm_overwrite: false,
            move_from_carrier_id: None,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["registrationId"], "r-1");
        assert_eq!(v["tareKg"], 154.4);
        assert_eq!(v["measured"]["grossKg"], 154.4);
        assert_eq!(v["measured"]["status"], "gross");
        assert_eq!(v["measured"]["stableMs"], 2000);
        assert_eq!(v["expected"]["rfidTag"], serde_json::Value::Null);
        assert_eq!(v["emptyConfirmed"], true);
        assert_eq!(v["moveFromCarrierId"], serde_json::Value::Null);
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
            credits_live: None,
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

    #[test]
    fn assignment_result_reads_credits_live_and_tolerates_its_absence() {
        let r: AssignmentResult = serde_json::from_str(r#"{"status":"credited","employeeName":"Ruben","pendingUntil":null,"creditsLive":false}"#).unwrap();
        assert_eq!(r.credits_live, Some(false));
        let r: AssignmentResult = serde_json::from_str(r#"{"status":"pending","employeeName":null,"pendingUntil":"x"}"#).unwrap();
        assert_eq!(r.credits_live, None);
    }
}
