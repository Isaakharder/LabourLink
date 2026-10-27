//! Serial port readers (one OS thread per port). Ports are opened, read and
//! reopened on failure; nothing is ever written to either device.

use std::io::Read;
use std::time::Duration;
use tokio::sync::mpsc::UnboundedSender;

use crate::app::{Input, LinkKind, LinkStatus};
use crate::rfid::{parse_protagd_line, LineFramer};
use crate::scale_proto::{parse_frame, ScaleFramer, ScaleProtocol};

#[derive(Clone, Copy)]
pub enum Device {
    Scale(ScaleProtocol),
    Rfid,
}

pub fn spawn_reader(device: Device, path: String, baud: u32, tx: UnboundedSender<Input>) {
    std::thread::Builder::new()
        .name(match device {
            Device::Scale(_) => "scale-port".into(),
            Device::Rfid => "rfid-port".into(),
        })
        .spawn(move || run(device, path, baud, tx))
        .expect("spawn serial thread");
}

fn link(device: Device, status: LinkStatus) -> Input {
    Input::Link(
        match device {
            Device::Scale(_) => LinkKind::Scale,
            Device::Rfid => LinkKind::Rfid,
        },
        status,
    )
}

fn run(device: Device, path: String, baud: u32, tx: UnboundedSender<Input>) {
    let mut last_error = String::new();
    loop {
        match serialport::new(&path, baud).timeout(Duration::from_millis(250)).open() {
            Ok(mut port) => {
                eprintln!("opened {path} at {baud} baud");
                let _ = tx.send(link(device, LinkStatus::new("connected", format!("{path} @ {baud}"))));
                let mut scale_framer = ScaleFramer::default();
                let mut rfid_framer = LineFramer::default();
                let mut buf = [0u8; 256];
                loop {
                    match port.read(&mut buf) {
                        Ok(0) => {}
                        Ok(n) => match device {
                            Device::Scale(protocol) => {
                                for frame in scale_framer.push(&buf[..n]) {
                                    if let Some(r) = parse_frame(protocol, &frame) {
                                        let _ = tx.send(Input::Reading(r));
                                    }
                                }
                            }
                            Device::Rfid => {
                                for line in rfid_framer.push(&buf[..n]) {
                                    if let Some(r) = parse_protagd_line(&line) {
                                        let _ = tx.send(Input::Tag(r.tag));
                                    }
                                }
                            }
                        },
                        Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                        Err(e) => {
                            eprintln!("{path}: read failed: {e}");
                            let _ = tx.send(link(device, LinkStatus::new("disconnected", format!("{path}: {e}"))));
                            break;
                        }
                    }
                }
            }
            Err(e) => {
                let msg = format!("{path}: {e}");
                if msg != last_error {
                    eprintln!("cannot open {msg}");
                    last_error = msg.clone();
                }
                let _ = tx.send(link(device, LinkStatus::new("disconnected", msg)));
            }
        }
        std::thread::sleep(Duration::from_secs(3));
    }
}

/// Serial devices visible on this machine, without libudev: stable
/// /dev/serial/by-id links plus the raw ttyUSB/ttyACM/ttyS nodes.
pub fn list_ports() -> Vec<String> {
    let mut out = vec![];
    if let Ok(entries) = std::fs::read_dir("/dev/serial/by-id") {
        for e in entries.flatten() {
            let p = e.path();
            let target = std::fs::canonicalize(&p).map(|t| t.display().to_string()).unwrap_or_default();
            out.push(format!("{} -> {}", p.display(), target));
        }
    }
    if let Ok(entries) = std::fs::read_dir("/dev/labourlink") {
        for e in entries.flatten() {
            out.push(format!(
                "{} -> {}",
                e.path().display(),
                std::fs::canonicalize(e.path()).map(|t| t.display().to_string()).unwrap_or_default()
            ));
        }
    }
    if let Ok(entries) = std::fs::read_dir("/dev") {
        let mut raw: Vec<String> = entries
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("ttyUSB") || n.starts_with("ttyACM"))
            .map(|n| format!("/dev/{n}"))
            .collect();
        raw.sort();
        out.extend(raw);
    }
    out
}
