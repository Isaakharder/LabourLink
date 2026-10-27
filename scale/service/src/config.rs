//! Station configuration (`/etc/labourlink-scale/config.json`).
//!
//! Simulation is the default. Live mode must be chosen explicitly and needs
//! an API base URL and a station token file; simulation mode never builds an
//! HTTP client at all, so simulated weighings cannot reach any server.

use serde::Deserialize;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use crate::machine::Params;
use crate::scale_proto::ScaleProtocol;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Simulation,
    Live,
}

impl Mode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Mode::Simulation => "simulation",
            Mode::Live => "live",
        }
    }
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
        Ok(())
    }

    /// Separate database files per mode, so simulated weighings never share
    /// a file (or an outbox) with real ones.
    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join(match self.mode {
            Mode::Simulation => "scale-sim.sqlite3",
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
