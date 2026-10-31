//! Serial port readers (one OS thread per port). Ports are opened, read and
//! reopened on failure; nothing is ever written to either device.

use std::io::Read;
use std::time::{Duration, Instant};
use tokio::sync::mpsc::UnboundedSender;

use crate::app::{Input, LinkKind, LinkStatus};
use crate::capture::printable;
use crate::rfid::{parse_protagd_line, LineFramer};
use crate::scale_proto::{parse_frame, Frame, ScaleFramer, ScaleProtocol};

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

/// Notices an indicator whose data arrives but never parses (a different
/// output format or setting than the configured protocol), so the station
/// reports "data not recognised" instead of a silent "no readings". It never
/// guesses at the data: unparsed frames are only counted and shown.
#[derive(Default)]
pub struct FormatWatch {
    unparsed: usize,
    last_good_ms: Option<u64>,
    last_report_ms: Option<u64>,
    flagged: bool,
}

const FORMAT_REPORT_MS: u64 = 5_000;

impl FormatWatch {
    /// A frame parsed. True if an earlier "not recognised" report must be cleared.
    pub fn good(&mut self, now_ms: u64) -> bool {
        self.last_good_ms = Some(now_ms);
        std::mem::take(&mut self.flagged)
    }

    /// A frame didn't parse. Returns the detail to report, at most every
    /// 5 s and only once nothing has parsed for 5 s.
    pub fn bad(&mut self, now_ms: u64, frame: &str) -> Option<String> {
        self.unparsed += 1;
        let quiet = self.last_good_ms.map_or(true, |t| now_ms.saturating_sub(t) >= FORMAT_REPORT_MS);
        let due = self.last_report_ms.map_or(true, |t| now_ms.saturating_sub(t) >= FORMAT_REPORT_MS);
        if !(quiet && due) {
            return None;
        }
        self.last_report_ms = Some(now_ms);
        self.flagged = true;
        Some(format!("{} frames not recognised, last: {frame}", self.unparsed))
    }
}

fn frame_text(f: &Frame) -> String {
    match f {
        Frame::Stx(b) => format!("<STX>{}<ETX>", printable(b.as_bytes())),
        Frame::Line(l) => printable(l.as_bytes()),
    }
}

/// Opens a port for reading at 8 data bits, no parity, 1 stop bit and no
/// flow control, as both devices are configured, rather than relying on the
/// library's defaults.
pub fn open_8n1(path: &str, baud: u32, timeout: Duration) -> serialport::Result<Box<dyn serialport::SerialPort>> {
    serialport::new(path, baud)
        .data_bits(serialport::DataBits::Eight)
        .parity(serialport::Parity::None)
        .stop_bits(serialport::StopBits::One)
        .flow_control(serialport::FlowControl::None)
        .timeout(timeout)
        .open()
}

fn run(device: Device, path: String, baud: u32, tx: UnboundedSender<Input>) {
    let mut last_error = String::new();
    loop {
        match open_8n1(&path, baud, Duration::from_millis(250)) {
            Ok(mut port) => {
                eprintln!("opened {path} at {baud} baud");
                let _ = tx.send(link(device, LinkStatus::new("connected", format!("{path} @ {baud}"))));
                let mut scale_framer = ScaleFramer::default();
                let mut watch = FormatWatch::default();
                let opened = Instant::now();
                let mut rfid_framer = LineFramer::default();
                let mut buf = [0u8; 256];
                loop {
                    match port.read(&mut buf) {
                        Ok(0) => {}
                        Ok(n) => match device {
                            Device::Scale(protocol) => {
                                for frame in scale_framer.push(&buf[..n]) {
                                    let now_ms = opened.elapsed().as_millis() as u64;
                                    if let Some(r) = parse_frame(protocol, &frame) {
                                        if watch.good(now_ms) {
                                            let _ = tx.send(link(device, LinkStatus::new("connected", format!("{path} @ {baud}"))));
                                        }
                                        let _ = tx.send(Input::Reading(r));
                                    } else if let Some(detail) = watch.bad(now_ms, &frame_text(&frame)) {
                                        eprintln!("{path}: indicator data not recognised as {protocol:?}: {detail}");
                                        let _ = tx.send(link(device, LinkStatus::new("unrecognized", format!("{path} @ {baud}: {detail}"))));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unparsed_data_is_reported_only_while_nothing_parses() {
        let mut w = FormatWatch::default();
        // Nothing has parsed yet: the first unparsed frame is reported.
        assert_eq!(w.bad(0, "<STX>x<ETX>").as_deref(), Some("1 frames not recognised, last: <STX>x<ETX>"));
        // Then at most every 5 s.
        assert_eq!(w.bad(1_000, "y"), None);
        assert_eq!(w.bad(5_000, "z").as_deref(), Some("3 frames not recognised, last: z"));
        // Good data clears the report once.
        assert!(w.good(5_100));
        assert!(!w.good(5_200));
        // An odd frame among good ones is not reported.
        assert_eq!(w.bad(6_000, "noise"), None);
        // Five seconds with no good frame: reported again.
        assert_eq!(w.bad(10_300, "bad").as_deref(), Some("5 frames not recognised, last: bad"));
    }
}
