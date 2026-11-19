//! `labourlink-scaled capture` — Stage 0 protocol capture.
//!
//! Records exactly what a serial device sends (timestamped hex + printable
//! text) and shows how the current parsers interpret it, so the indicator
//! and RFID formats can be confirmed on the NUC before go-live. Read-only:
//! the port is opened and read, never written, so it cannot alter the
//! indicator's calibration or settings.
//!
//! At the end it prints a summary for confirming the indicator format:
//! every distinct frame shape, each trailing status letter with how often
//! and over what weights it appeared, the frame rate, and the frames as a
//! time-ordered list of runs. Do things to the scale at known times during
//! the capture (empty, place a bin, rock it, leave it still, remove it) and
//! read the runs against them, so the meaning of each status letter comes
//! from the real indicator rather than from the manual.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::time::{Duration, Instant};

use crate::rfid::{parse_protagd_line, LineFramer};
use crate::scale_proto::{parse_frame, Frame, ScaleFramer, ScaleProtocol};

pub fn printable(bytes: &[u8]) -> String {
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

fn escaped(s: &str) -> String {
    printable(s.as_bytes())
}

fn kg(g: i64) -> String {
    format!("{:.3}", g as f64 / 1000.0).trim_end_matches('0').trim_end_matches('.').to_string()
}

/// What one frame looked like, for the summary: its shape (for an STX
/// frame, its length and last character) and the weight if a parser read one.
fn frame_key(f: &Frame) -> (String, Option<i64>) {
    match f {
        Frame::Stx(body) => {
            let status = body.chars().last().map(|c| c.to_string()).unwrap_or_default();
            (
                format!("STX body {} chars, ends {:?}", body.chars().count(), status),
                parse_frame(ScaleProtocol::RinstrumAutoA, f).and_then(|r| r.weight_g),
            )
        }
        Frame::Line(line) => (
            format!("LINE {} chars", line.chars().count()),
            parse_frame(ScaleProtocol::GenericLine, f).and_then(|r| r.weight_g),
        ),
    }
}

#[derive(Default)]
struct Shape {
    count: usize,
    example: String,
    min_g: Option<i64>,
    max_g: Option<i64>,
}

struct Run {
    shape: String,
    from_ms: u128,
    to_ms: u128,
    count: usize,
    min_g: Option<i64>,
    max_g: Option<i64>,
}

/// Accumulates indicator frames for the end-of-capture summary.
#[derive(Default)]
pub struct FrameSummary {
    shapes: BTreeMap<String, Shape>,
    runs: Vec<Run>,
    first_ms: Option<u128>,
    last_ms: u128,
    total: usize,
}

fn widen(min: &mut Option<i64>, max: &mut Option<i64>, w: Option<i64>) {
    if let Some(w) = w {
        *min = Some(min.map_or(w, |m| m.min(w)));
        *max = Some(max.map_or(w, |m| m.max(w)));
    }
}

fn range(min: Option<i64>, max: Option<i64>) -> String {
    match (min, max) {
        (Some(a), Some(b)) if a == b => format!("{} kg", kg(a)),
        (Some(a), Some(b)) => format!("{}..{} kg", kg(a), kg(b)),
        _ => "no weight parsed".into(),
    }
}

impl FrameSummary {
    pub fn add(&mut self, at_ms: u128, f: &Frame) {
        let (shape, weight) = frame_key(f);
        self.total += 1;
        self.first_ms.get_or_insert(at_ms);
        self.last_ms = at_ms;
        let e = self.shapes.entry(shape.clone()).or_default();
        e.count += 1;
        if e.example.is_empty() {
            e.example = match f {
                Frame::Stx(b) => format!("<STX>{}<ETX>", escaped(b)),
                Frame::Line(l) => escaped(l),
            };
        }
        widen(&mut e.min_g, &mut e.max_g, weight);
        match self.runs.last_mut() {
            Some(r) if r.shape == shape => {
                r.to_ms = at_ms;
                r.count += 1;
                widen(&mut r.min_g, &mut r.max_g, weight);
            }
            _ => {
                let mut r = Run {
                    shape,
                    from_ms: at_ms,
                    to_ms: at_ms,
                    count: 1,
                    min_g: None,
                    max_g: None,
                };
                widen(&mut r.min_g, &mut r.max_g, weight);
                self.runs.push(r);
            }
        }
    }

    /// Frames per second over the capture, once it has seen two.
    pub fn rate(&self) -> Option<f64> {
        let first = self.first_ms?;
        let span = self.last_ms.saturating_sub(first);
        (self.total >= 2 && span > 0).then(|| (self.total - 1) as f64 * 1000.0 / span as f64)
    }

    pub fn report(&self) -> Vec<String> {
        let mut out = vec![];
        if self.total == 0 {
            out.push("# scale summary: no STX/ETX frames or text lines seen".into());
            return out;
        }
        out.push(format!(
            "# scale summary: {} frames, {}",
            self.total,
            self.rate().map_or("rate unknown".into(), |r| format!("{r:.1} frames/s"))
        ));
        out.push("# frame shapes (status letter = last character of an STX frame):".into());
        for (shape, s) in &self.shapes {
            out.push(format!("#   {shape}: {} frames, {}, e.g. {}", s.count, range(s.min_g, s.max_g), s.example));
        }
        out.push("# runs, in order (compare with what was done to the scale and when):".into());
        for r in &self.runs {
            out.push(format!(
                "#   +{:>7.1}s .. +{:>7.1}s  {:>5} x  {}  {}",
                r.from_ms as f64 / 1000.0,
                r.to_ms as f64 / 1000.0,
                r.count,
                r.shape,
                range(r.min_g, r.max_g)
            ));
        }
        if self.rate().is_some_and(|r| r < 2.5) {
            out.push("# WARNING: under 2.5 frames/s. The stable window needs stableMinSamples readings within stableWindowMs".into());
        }
        out
    }
}

/// RFID reads per tag, to see whether the reader repeats a tag in range.
#[derive(Default)]
pub struct TagSummary {
    tags: BTreeMap<String, (usize, u128, u128, String)>,
}

impl TagSummary {
    pub fn add(&mut self, at_ms: u128, tag: &str, field: &str) {
        let e = self.tags.entry(tag.to_string()).or_insert((0, at_ms, at_ms, field.to_string()));
        e.0 += 1;
        e.2 = at_ms;
    }

    pub fn report(&self) -> Vec<String> {
        if self.tags.is_empty() {
            return vec![];
        }
        let mut out = vec!["# RFID summary (tag: reads, first..last, reader field):".to_string()];
        for (tag, (n, first, last, field)) in &self.tags {
            out.push(format!(
                "#   {tag}: {n} reads, +{:.1}s..+{:.1}s, field {field}",
                *first as f64 / 1000.0,
                *last as f64 / 1000.0
            ));
        }
        out
    }
}

pub fn run(port: &str, baud: u32, seconds: u64, out: Option<&str>) -> Result<(), String> {
    let mut sp = crate::serial::open_8n1(port, baud, Duration::from_millis(200)).map_err(|e| format!("open {port}: {e}"))?;
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
    let mut summary = FrameSummary::default();
    let mut tags = TagSummary::default();
    while start.elapsed() < Duration::from_secs(seconds) {
        match sp.read(&mut buf) {
            Ok(n) if n > 0 => {
                bytes_total += n;
                let chunk = &buf[..n];
                let hex: Vec<String> = chunk.iter().map(|b| format!("{b:02X}")).collect();
                emit(format!("+{:>8}ms RAW {} |{}|", start.elapsed().as_millis(), hex.join(" "), printable(chunk)));
                let at_ms = start.elapsed().as_millis();
                for f in scale_framer.push(chunk) {
                    frames += 1;
                    summary.add(at_ms, &f);
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
                        tags.add(at_ms, &r.tag, &r.reader_field);
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
    for line in summary.report().into_iter().chain(tags.report()) {
        emit(line);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stx(body: &str) -> Frame {
        Frame::Stx(body.into())
    }

    #[test]
    fn summary_groups_shapes_and_orders_runs_by_time() {
        let mut s = FrameSummary::default();
        for i in 0..10 {
            s.add(i * 100, &stx("    0.0G"));
        }
        s.add(1_000, &stx("    0.0G "));
        s.add(1_100, &stx("   41.2M"));
        s.add(1_200, &stx("   93.4M"));
        s.add(1_300, &stx("   93.0G"));
        s.add(1_400, &Frame::Line("junk".into()));
        let report = s.report().join("\n");
        // Every distinct shape is listed with its own count and an example.
        assert!(report.contains(r#"STX body 8 chars, ends "G": 11 frames"#), "{report}");
        assert!(report.contains(r#"STX body 9 chars, ends " ": 1 frames"#), "{report}");
        assert!(report.contains("<STX>   41.2M<ETX>"), "{report}");
        assert!(report.contains("LINE 4 chars: 1 frames, no weight parsed, e.g. junk"), "{report}");
        // Runs keep the order the indicator sent them in.
        let runs: Vec<&str> = report.lines().filter(|l| l.contains(" x  ")).collect();
        assert_eq!(runs.len(), 5, "{report}");
        assert!(runs[2].contains(r#"ends "M""#) && runs[2].contains("2 x"), "{}", runs[2]);
        assert!((s.rate().unwrap() - 10.0).abs() < 0.01);
    }

    #[test]
    fn nine_char_format_a_frames_report_their_weights_and_a_slow_rate() {
        let mut s = FrameSummary::default();
        s.add(0, &stx("    93.0G"));
        s.add(500, &stx("   110.2G"));
        let report = s.report().join("\n");
        assert!(report.contains(r#"STX body 9 chars, ends "G": 2 frames, 93..110.2 kg"#), "{report}");
        assert!(report.contains("WARNING: under 2.5 frames/s"), "{report}");
    }

    #[test]
    fn empty_capture_and_tag_summary() {
        assert!(FrameSummary::default().report()[0].contains("no STX/ETX frames"));
        let mut t = TagSummary::default();
        t.add(100, "0000000182225750", "0000");
        t.add(900, "0000000182225750", "0000");
        assert_eq!(t.report()[1], "#   0000000182225750: 2 reads, +0.1s..+0.9s, field 0000");
    }
}
