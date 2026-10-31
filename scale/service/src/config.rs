//! Station configuration (`/etc/labourlink-scale/config.json`).
//!
//! Simulation is the default. Live mode must be chosen explicitly and needs
//! an API base URL and a station token file; simulation mode never builds an
//! HTTP client at all, so simulated weighings cannot reach any server.
//!
//! Hardware-test mode reads the real scale and RFID reader but, like
//! simulation, uses the in-process test server and never builds an HTTP
//! client. Its bins (`testCarriers`) come from this file, and its weighings
//! are test data in their own database.

use serde::Deserialize;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use crate::machine::{CarrierInfo, Params};
use crate::rfid::{is_valid_rfid_tag, normalize_rfid_tag};
use crate::scale_proto::ScaleProtocol;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Mode {
    Simulation,
    HardwareTest,
    Live,
}

impl Mode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Mode::Simulation => "simulation",
            Mode::HardwareTest => "hardware-test",
            Mode::Live => "live",
        }
    }

    /// Weighings are test data (stored with `simulated = 1`) and only ever
    /// reach the in-process test server.
    pub fn is_test(&self) -> bool {
        *self != Mode::Live
    }

    /// Readings and tags come from the serial ports, not the simulator rig.
    pub fn uses_hardware(&self) -> bool {
        *self != Mode::Simulation
    }
}

/// A bin for hardware-test mode: a real RFID tag with the bin's real tare,
/// copied by hand from the Carriers page. Never sent anywhere.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestCarrier {
    pub name: String,
    #[serde(default)]
    pub rfid_tag: Option<String>,
    pub tare_kg: f64,
    #[serde(default = "active")]
    pub is_active: bool,
}

fn active() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SerialConfig {
    pub port: String,
    pub baud: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScaleConfig {
    pub port: String,
    pub baud: u32,
    pub protocol: ScaleProtocol,
}

impl Default for ScaleConfig {
    fn default() -> Self {
        Self {
            port: "/dev/labourlink/scale".into(),
            baud: 9600,
            protocol: ScaleProtocol::RinstrumAutoA,
        }
    }
}

impl Default for SerialConfig {
    fn default() -> Self {
        Self {
            port: "/dev/labourlink/rfid".into(),
            baud: 9600,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WeighingOverrides {
    pub settle_seconds: Option<u64>,
    pub stable_window_ms: Option<u64>,
    pub stable_min_samples: Option<usize>,
    pub stable_tolerance_kg: Option<f64>,
    pub min_load_kg: Option<f64>,
    pub zero_threshold_kg: Option<f64>,
    pub removal_ms: Option<u64>,
    pub tag_window_ms: Option<u64>,
    pub min_net_kg: Option<f64>,
    pub duplicate_guard_seconds: Option<u64>,
    pub scale_timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub mode: Mode,
    pub station_name: String,
    pub data_dir: PathBuf,
    pub listen: SocketAddr,
    pub api_base_url: Option<String>,
    pub station_token_file: PathBuf,
    pub scale: ScaleConfig,
    pub rfid: SerialConfig,
    pub weighing: WeighingOverrides,
    pub pending_poll_seconds: u64,
    pub carrier_refresh_seconds: u64,
    pub test_carriers: Vec<TestCarrier>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            mode: Mode::Simulation,
            station_name: "Weighing station".into(),
            data_dir: PathBuf::from("./data"),
            listen: "127.0.0.1:47800".parse().unwrap(),
            api_base_url: None,
            station_token_file: PathBuf::from("/etc/labourlink-scale/station-token"),
            scale: ScaleConfig::default(),
            rfid: SerialConfig::default(),
            weighing: WeighingOverrides::default(),
            pending_poll_seconds: 60,
            carrier_refresh_seconds: 300,
            test_carriers: vec![],
        }
    }
}

fn kg(v: f64) -> i64 {
    (v * 1000.0).round() as i64
}

impl Config {
    pub fn load(path: Option<&Path>) -> Result<Config, String> {
        let cfg: Config = match path {
            Some(p) if p.exists() => {
                let text = std::fs::read_to_string(p).map_err(|e| format!("reading {}: {e}", p.display()))?;
                serde_json::from_str(&text).map_err(|e| format!("parsing {}: {e}", p.display()))?
            }
            Some(p) => {
                eprintln!("config {} not found, using defaults (simulation mode)", p.display());
                Config::default()
            }
            None => Config::default(),
        };
        cfg.validate()?;
        Ok(cfg)
    }

    pub fn validate(&self) -> Result<(), String> {
        if !self.listen.ip().is_loopback() {
            return Err(format!(
                "listen address {} must be loopback (127.0.0.1): the local API is not authenticated",
                self.listen
            ));
        }
        if self.mode == Mode::Live {
            let url = self.api_base_url.as_deref().unwrap_or("");
            if !(url.starts_with("https://") || url.starts_with("http://127.0.0.1") || url.starts_with("http://localhost")) {
                return Err("live mode needs apiBaseUrl (https://…)".into());
            }
        }
        if self.mode == Mode::HardwareTest {
            self.test_carrier_infos()?;
        }
        Ok(())
    }

    /// `testCarriers` as the test server's bins. Tags are normalized with the
    /// server's rule; a malformed or repeated tag, a blank name or a tare
    /// that isn't positive is a config error rather than a silently
    /// unusable bin.
    pub fn test_carrier_infos(&self) -> Result<Vec<CarrierInfo>, String> {
        let mut out: Vec<CarrierInfo> = vec![];
        for (i, c) in self.test_carriers.iter().enumerate() {
            let at = format!("testCarriers[{i}]");
            if c.name.trim().is_empty() {
                return Err(format!("{at}.name is empty"));
            }
            if !(c.tare_kg.is_finite() && c.tare_kg > 0.0 && c.tare_kg < 1000.0) {
                return Err(format!("{at}.tareKg must be the bin's real tare in kg (more than 0)"));
            }
            let tag = match c.rfid_tag.as_deref().map(normalize_rfid_tag) {
                None => None,
                Some(t) if t.is_empty() => None,
                Some(t) if !is_valid_rfid_tag(&t) => return Err(format!("{at}.rfidTag {t:?} may only contain letters and digits (max 64)")),
                Some(t) => Some(t),
            };
            if let Some(t) = &tag {
                if let Some(other) = out.iter().find(|o| o.rfid_tag.as_ref() == Some(t)) {
                    return Err(format!("{at}.rfidTag {t} is already used by {:?}", other.name));
                }
            }
            out.push(CarrierInfo {
                id: format!("test-carrier-{:02}", i + 1),
                name: c.name.trim().to_string(),
                rfid_tag: tag,
                tare_g: kg(c.tare_kg),
                is_active: c.is_active,
            });
        }
        Ok(out)
    }

    /// Separate database files per mode, so simulated weighings never share
    /// a file (or an outbox) with real ones.
    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join(match self.mode {
            Mode::Simulation => "scale-sim.sqlite3",
            Mode::HardwareTest => "scale-hwtest.sqlite3",
            Mode::Live => "scale.sqlite3",
        })
    }

    pub fn params(&self) -> Params {
        let d = Params::default();
        let o = &self.weighing;
        Params {
            settle_ms: o.settle_seconds.map(|s| s * 1000).unwrap_or(d.settle_ms),
            stable_window_ms: o.stable_window_ms.unwrap_or(d.stable_window_ms),
            stable_min_samples: o.stable_min_samples.unwrap_or(d.stable_min_samples),
            stable_tolerance_g: o.stable_tolerance_kg.map(kg).unwrap_or(d.stable_tolerance_g),
            min_load_g: o.min_load_kg.map(kg).unwrap_or(d.min_load_g),
            zero_threshold_g: o.zero_threshold_kg.map(kg).unwrap_or(d.zero_threshold_g),
            removal_ms: o.removal_ms.unwrap_or(d.removal_ms),
            tag_window_ms: o.tag_window_ms.unwrap_or(d.tag_window_ms),
            min_net_g: o.min_net_kg.map(kg).unwrap_or(d.min_net_g),
            duplicate_guard_ms: o.duplicate_guard_seconds.map(|s| s * 1000).unwrap_or(d.duplicate_guard_ms),
            scale_timeout_ms: o.scale_timeout_ms.unwrap_or(d.scale_timeout_ms),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_simulation_on_loopback() {
        let c = Config::default();
        assert_eq!(c.mode, Mode::Simulation);
        assert!(c.validate().is_ok());
        assert!(c.db_path().ends_with("scale-sim.sqlite3"));
        assert_eq!(c.params().settle_ms, 10_000);
    }

    #[test]
    fn live_mode_requires_api_url_and_uses_its_own_db() {
        let c: Config = serde_json::from_str(r#"{"mode":"live"}"#).unwrap();
        assert!(c.validate().is_err());
        let c: Config = serde_json::from_str(r#"{"mode":"live","apiBaseUrl":"https://api.example.com"}"#).unwrap();
        assert!(c.validate().is_ok());
        assert!(c.db_path().ends_with("scale.sqlite3"));
    }

    #[test]
    fn hardware_test_mode_has_its_own_db_and_validated_test_bins() {
        let c: Config = serde_json::from_str(
            r#"{"mode":"hardware-test","testCarriers":[
                {"name":"Bin 23","rfidTag":" 0000 0001 8222 5750 ","tareKg":27.5},
                {"name":"Bin 24","tareKg":27.25,"isActive":false}]}"#,
        )
        .unwrap();
        assert_eq!(c.mode, Mode::HardwareTest);
        assert!(c.mode.is_test() && c.mode.uses_hardware());
        assert!(c.validate().is_ok(), "no apiBaseUrl needed: it never contacts a server");
        assert!(c.db_path().ends_with("scale-hwtest.sqlite3"));
        let bins = c.test_carrier_infos().unwrap();
        assert_eq!(bins[0].rfid_tag.as_deref(), Some("0000000182225750"));
        assert_eq!((bins[0].tare_g, bins[1].tare_g), (27_500, 27_250));
        assert_eq!((bins[0].id.as_str(), bins[1].is_active, &bins[1].rfid_tag), ("test-carrier-01", false, &None));
        assert!(!Mode::Simulation.uses_hardware() && Mode::Simulation.is_test());
        assert!(Mode::Live.uses_hardware() && !Mode::Live.is_test());
    }

    #[test]
    fn hardware_test_mode_rejects_bad_test_bins() {
        for (bins, msg) in [
            (r#"[{"name":"A","tareKg":0}]"#, "tareKg"),
            (r#"[{"name":"A"}]"#, "tareKg"),
            (r#"[{"name":" ","tareKg":27}]"#, "name"),
            (r#"[{"name":"A","rfidTag":"AB-12","tareKg":27}]"#, "letters and digits"),
            (r#"[{"name":"A","rfidTag":"12","tareKg":27},{"name":"B","rfidTag":" 12","tareKg":27}]"#, "already used"),
            (r#"[{"name":"A","tare":27}]"#, "tare"),
        ] {
            let parsed: Result<Config, _> = serde_json::from_str(&format!(r#"{{"mode":"hardware-test","testCarriers":{bins}}}"#));
            let e = match parsed {
                Ok(c) => c.validate().unwrap_err(),
                Err(e) => e.to_string(),
            };
            assert!(e.contains(msg), "{bins}: {e}");
        }
    }

    #[test]
    fn packaged_hardware_test_config_is_valid_and_uses_stable_device_paths() {
        let c: Config = serde_json::from_str(include_str!("../../packaging/config.hardware-test.json")).unwrap();
        assert_eq!(c.mode, Mode::HardwareTest);
        assert!(c.validate().is_ok());
        assert_eq!(c.scale.port, "/dev/serial/by-id/usb-FTDI_FT232R_USB_UART_BG0427FU-if00-port0");
        assert_eq!((c.scale.baud, c.scale.protocol, c.rfid.baud), (9600, ScaleProtocol::RinstrumAutoA, 9600));
        assert!(!c.rfid.port.contains("ttyUSB") && !c.scale.port.contains("ttyUSB"), "never the ttyUSB numbering");
        assert!(c.api_base_url.is_none());
    }

    #[test]
    fn refuses_non_loopback_listen() {
        let c: Config = serde_json::from_str(r#"{"listen":"0.0.0.0:47800"}"#).unwrap();
        assert!(c.validate().is_err());
    }

    #[test]
    fn overrides_convert_kg_to_grams() {
        let c: Config = serde_json::from_str(r#"{"weighing":{"stableToleranceKg":0.02,"settleSeconds":12}}"#).unwrap();
        let p = c.params();
        assert_eq!((p.stable_tolerance_g, p.settle_ms), (20, 12_000));
    }
}
