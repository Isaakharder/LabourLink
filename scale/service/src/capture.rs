//! `labourlink-scaled capture` — Stage 0 protocol capture.
//!
//! Records exactly what a serial device sends (timestamped hex + printable
//! text) and shows how the current parsers interpret it, so the indicator
//! and RFID formats can be confirmed on the NUC before go-live. Read-only:
//! the port is opened and read, never written, so it cannot alter the
//! indicator's calibration or settings.

use std::io::{Read, Write};
use std::time::{Duration, Instant};

use crate::rfid::{parse_protagd_line, LineFramer};
use crate::scale_proto::{parse_frame, Frame, ScaleFramer, ScaleProtocol};

fn printable(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|&b| match b {
            0x02 => "<STX>".to_string(),
            0x03 => "<ETX>".to_string(),
            b'\r' => "<CR>".to_string(),
            b'\n' => "<LF>".to_string(),
            0x20..=0x7e => (b as char).to_string(),
            _ => format!("<{b:02X}>"),
        })
        .collect()
}

pub fn run(port: &str, baud: u32, seconds: u64, out: Option<&str>) -> Result<(), String> {
    let mut sp = serialport::new(port, baud)
        .timeout(Duration::from_millis(200))
        .open()
        .map_err(|e| format!("open {port}: {e}"))?;
    let mut file = match out {
        Some(p) => Some(std::fs::File::create(p).map_err(|e| format!("create {p}: {e}"))?),
        None => None,
    };
    let mut emit = |line: String| {
        println!("{line}");
        if let Some(f) = file.as_mut() {
            let _ = writeln!(f, "{line}");
        }
    };
    emit(format!("# capture {port} @ {baud} 8N1 for {seconds}s (read-only)"));
    let start = Instant::now();
    let mut scale_framer = ScaleFramer::default();
    let mut rfid_framer = LineFramer::default();
    let mut buf = [0u8; 512];
    let (mut bytes_total, mut frames, mut parsed_a, mut parsed_line, mut parsed_rfid) = (0usize, 0usize, 0usize, 0usize, 0usize);
    while start.elapsed() < Duration::from_secs(seconds) {
        match sp.read(&mut buf) {
            Ok(n) if n > 0 => {
                bytes_total += n;
                let chunk = &buf[..n];
                let hex: Vec<String> = chunk.iter().map(|b| format!("{b:02X}")).collect();
                emit(format!("+{:>8}ms RAW {} |{}|", start.elapsed().as_millis(), hex.join(" "), printable(chunk)));
                for f in scale_framer.push(chunk) {
                    frames += 1;
                    let a = parse_frame(ScaleProtocol::RinstrumAutoA, &f);
                    let l = parse_frame(ScaleProtocol::GenericLine, &f);
                    parsed_a += a.is_some() as usize;
                    parsed_line += l.is_some() as usize;
                    let text = match &f {
                        Frame::Stx(s) => format!("STX[{s}]"),
                        Frame::Line(s) => format!("LINE[{s}]"),
                    };
                    emit(format!("           FRAME {text} rinstrum-auto-a={a:?} generic-line={l:?}"));
                }
                for line in rfid_framer.push(chunk) {
                    if let Some(r) = parse_protagd_line(&line) {
                        parsed_rfid += 1;
                        emit(format!("           RFID tag={} field={}", r.tag, r.reader_field));
                    }
                }
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(e) => return Err(format!("read: {e}")),
        }
    }
    emit(format!(
        "# done: {bytes_total} bytes, {frames} frames, rinstrum-auto-a parsed {parsed_a}, generic-line parsed {parsed_line}, protagd lines {parsed_rfid}"
    ));
    Ok(())
}
