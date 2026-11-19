//! labourlink-scaled — LabourLink Scale background service.
//!
//!   labourlink-scaled [--config /etc/labourlink-scale/config.json]
//!   labourlink-scaled list-ports
//!   labourlink-scaled capture --port /dev/ttyUSB0 [--baud 9600] [--seconds 60] [--out file.txt]

mod app;
mod backend;
mod capture;
mod config;
mod machine;
mod matching;
mod registration;
mod rfid;
mod scale_proto;
mod serial;
mod server;
mod sim;
mod store;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use app::{App, Input};
use backend::{Backend, HttpBackend};
use config::{Config, Mode};
use store::Store;

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("list-ports") => {
            for p in serial::list_ports() {
                println!("{p}");
            }
        }
        Some("capture") => {
            let Some(port) = arg(&args, "--port") else {
                eprintln!("usage: labourlink-scaled capture --port /dev/ttyUSB0 [--baud 9600] [--seconds 60] [--out file]");
                std::process::exit(2);
            };
            let baud = arg(&args, "--baud").and_then(|b| b.parse().ok()).unwrap_or(9600);
            let seconds = arg(&args, "--seconds").and_then(|s| s.parse().ok()).unwrap_or(60);
            if let Err(e) = capture::run(&port, baud, seconds, arg(&args, "--out").as_deref()) {
                eprintln!("{e}");
                std::process::exit(1);
            }
        }
        _ => {
            let path = arg(&args, "--config")
                .or_else(|| std::env::var("LABOURLINK_SCALE_CONFIG").ok())
                .map(PathBuf::from);
            let cfg = match Config::load(path.as_deref()) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("config error: {e}");
                    std::process::exit(2);
                }
            };
            if let Err(e) = serve(cfg) {
                eprintln!("{e}");
                std::process::exit(1);
            }
        }
    }
}

#[tokio::main(flavor = "current_thread")]
async fn serve(cfg: Config) -> Result<(), String> {
    let store = Store::open(&cfg.db_path(), cfg.mode)?;
    eprintln!(
        "LabourLink Scale service — {} mode — db {}",
        cfg.mode.as_str().to_uppercase(),
        cfg.db_path().display()
    );

    let (backend, sim): (Arc<dyn Backend>, _) = match cfg.mode {
        Mode::Simulation => {
            if cfg.api_base_url.is_some() {
                eprintln!("simulation mode: apiBaseUrl is ignored, no network calls are made");
            }
            let server = Arc::new(sim::SimServer::new());
            let rig = Arc::new(sim::SimRig::new());
            (server.clone() as Arc<dyn Backend>, Some((server, rig)))
        }
        Mode::HardwareTest => {
            // Real serial ports, but the same in-process test server as
            // simulation: no HTTP client exists, so nothing can be uploaded.
            if cfg.api_base_url.is_some() {
                eprintln!("hardware-test mode: apiBaseUrl is ignored, no network calls are made");
            }
            let bins = cfg.test_carrier_infos()?;
            eprintln!(
                "hardware-test mode: scale {} @ {}, RFID {} @ {}, {} test bin(s)",
                cfg.scale.port,
                cfg.scale.baud,
                cfg.rfid.port,
                cfg.rfid.baud,
                bins.len()
            );
            for b in &bins {
                eprintln!(
                    "  test bin {:?} tag {} tare {} g{}",
                    b.name,
                    b.rfid_tag.as_deref().unwrap_or("(none)"),
                    b.tare_g,
                    if b.is_active { "" } else { " (inactive)" }
                );
            }
            (Arc::new(sim::SimServer::with_carriers(bins)) as Arc<dyn Backend>, None)
        }
        Mode::Live => {
            // Under systemd the root-only token file is passed in via
            // LoadCredential; fall back to the configured path otherwise.
            let token_path = std::env::var_os("CREDENTIALS_DIRECTORY")
                .map(|d| PathBuf::from(d).join("station-token"))
                .filter(|p| p.exists())
                .unwrap_or_else(|| cfg.station_token_file.clone());
            let token = std::fs::read_to_string(&token_path)
                .ok()
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty());
            if token.is_none() {
                eprintln!(
                    "WARNING: station token file {} missing; weighings will queue until it is installed",
                    cfg.station_token_file.display()
                );
            }
            (
                Arc::new(HttpBackend::new(cfg.api_base_url.as_deref().unwrap(), token)) as Arc<dyn Backend>,
                None,
            )
        }
    };

    let listen = cfg.listen;
    let (app, wake_rx, snapshots) = App::new(cfg, store, backend, sim);
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Input>();

    if app.mode().uses_hardware() {
        serial::spawn_reader(
            serial::Device::Scale(app.cfg.scale.protocol),
            app.cfg.scale.port.clone(),
            app.cfg.scale.baud,
            tx.clone(),
        );
        serial::spawn_reader(serial::Device::Rfid, app.cfg.rfid.port.clone(), app.cfg.rfid.baud, tx.clone());
    }

    {
        let app = app.clone();
        std::thread::Builder::new()
            .name("uploader".into())
            .spawn(move || app::run_uploader(app, wake_rx))
            .map_err(|e| e.to_string())?;
    }

    // Engine loop: hardware input + 10 Hz tick (+ simulated hardware).
    {
        let app = app.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(100));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    Some(input) = rx.recv() => app.handle(input),
                    _ = tick.tick() => {
                        if let Some((_, rig)) = &app.sim {
                            let out = rig.step(app.now_ms());
                            for t in out.tags { app.handle(Input::Tag(t)); }
                            if let Some(r) = out.reading { app.handle(Input::Reading(r)); }
                        }
                        app.tick();
                    }
                }
            }
        });
    }

    let listener = tokio::net::TcpListener::bind(listen).await.map_err(|e| format!("bind {listen}: {e}"))?;
    eprintln!("local API on http://{listen}");
    let router = server::router(app.clone(), snapshots);
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .map_err(|e| e.to_string())
}
