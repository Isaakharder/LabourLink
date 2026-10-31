//! Scale indicator output parsing (Rinstrum R300 family).
//!
//! UNVERIFIED AGAINST HARDWARE. The R300's serial output has not been
//! captured yet (RS-232 adapter pending). Two strict formats are supported
//! and selected by config; the `capture` subcommand records the real output
//! so the right one (or a new one) can be confirmed before go-live:
//!
//! * `rinstrum-auto-a` — Rinstrum auto-transmit "Format A" as documented for
//!   Rinstrum indicators: `STX <sign> <weight, 7 chars incl. point> <status> ETX`
//!   where status is G (gross), N (net), U (underload), O (overload),
//!   M (motion) or E (error).
//! * `generic-line` — a CR/LF-terminated ASCII line such as `ST,GS,+0027.50kg`
//!   or `  27.50 kg G`, for indicators configured with a custom string.
//!
//! The service only ever READS the indicator port. It never writes to it, so
//! it cannot change calibration, zero, tare or any indicator setting.
//!
//! Weights are carried as integer grams to avoid float rounding when the net
//! weight (gross − carrier tare) is computed and stored.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum IndicatorMode {
    Gross,
    Net,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reading {
    /// Displayed weight in grams. None when the indicator reports a
    /// condition (overload, underload, error) instead of a weight.
    pub weight_g: Option<i64>,
    pub mode: IndicatorMode,
    pub motion: bool,
    pub overload: bool,
    pub underload: bool,
    pub error: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ScaleProtocol {
    RinstrumAutoA,
    GenericLine,
}

/// Parses a decimal kg string (e.g. "-0027.50", "  12.3", "120") into grams.
/// Rejects more than 3 decimals (sub-gram) and anything non-numeric.
pub fn parse_kg_to_grams(s: &str) -> Option<i64> {
    let s: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    let (neg, body) = match s.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, s.strip_prefix('+').unwrap_or(&s)),
    };
    if body.is_empty() {
        return None;
    }
    let (int_part, frac_part) = match body.split_once('.') {
        Some((i, f)) => (i, f),
        None => (body, ""),
    };
    if int_part.is_empty() && frac_part.is_empty() {
        return None;
    }
    if !int_part.chars().all(|c| c.is_ascii_digit()) || !frac_part.chars().all(|c| c.is_ascii_digit()) || frac_part.len() > 3 {
        return None;
    }
    let int_val: i64 = if int_part.is_empty() { 0 } else { int_part.parse().ok()? };
    let mut frac = frac_part.to_string();
    while frac.len() < 3 {
        frac.push('0');
    }
    let frac_val: i64 = frac.parse().ok()?;
    let g = int_val.checked_mul(1000)?.checked_add(frac_val)?;
    Some(if neg { -g } else { g })
}

/// Rinstrum Format A frame body (the bytes between STX and ETX).
pub fn parse_rinstrum_auto_a(body: &str) -> Option<Reading> {
    let chars: Vec<char> = body.chars().collect();
    // sign + 7 weight chars + status
    if chars.len() != 9 {
        return None;
    }
    let sign = chars[0];
    if sign != ' ' && sign != '-' && sign != '+' {
        return None;
    }
    let weight_str: String = chars[1..8].iter().collect();
    let status = chars[8];
    let mut r = Reading {
        weight_g: None,
        mode: IndicatorMode::Unknown,
        motion: false,
        overload: false,
        underload: false,
        error: false,
    };
    match status {
        'G' => r.mode = IndicatorMode::Gross,
        'N' => r.mode = IndicatorMode::Net,
        'M' => r.motion = true,
        'O' => r.overload = true,
        'U' => r.underload = true,
        'E' => r.error = true,
        _ => return None,
    }
    if r.overload || r.underload || r.error {
        return Some(r);
    }
    let g = parse_kg_to_grams(&weight_str)?;
    r.weight_g = Some(if sign == '-' { -g } else { g });
    Some(r)
}

/// Generic ASCII line: optional `ST,`/`US,`/`OL,` stability prefix, optional
/// `GS,`/`NT,` mode prefix, a signed decimal, optional `kg`, optional
/// trailing status letter(s). Any other unit (lb) is rejected.
pub fn parse_generic_line(line: &str) -> Option<Reading> {
    let mut s = line.trim().to_string();
    let mut r = Reading {
        weight_g: None,
        mode: IndicatorMode::Unknown,
        motion: false,
        overload: false,
        underload: false,
        error: false,
    };
    let take_prefix = |s: &mut String, p: &str| -> bool {
        if s.starts_with(p) {
            *s = s[p.len()..].to_string();
            true
        } else {
            false
        }
    };
    if take_prefix(&mut s, "ST,") {
    } else if take_prefix(&mut s, "US,") {
        r.motion = true;
    } else if take_prefix(&mut s, "OL,") {
        r.overload = true;
        return Some(r);
    }
    if take_prefix(&mut s, "GS,") {
        r.mode = IndicatorMode::Gross;
    } else if take_prefix(&mut s, "NT,") {
        r.mode = IndicatorMode::Net;
    }
    let s = s.trim();
    let num_end = s
        .find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-' || c == '+' || c == ' '))
        .unwrap_or(s.len());
    let (num, rest) = s.split_at(num_end);
    let g = parse_kg_to_grams(num)?;
    let rest = rest.trim();
    let rest = if let Some(r2) = rest.strip_prefix("kg") {
        r2.trim()
    } else if rest.starts_with("lb") || rest.starts_with("t") {
        return None;
    } else {
        rest
    };
    match rest {
        "" => {}
        "G" | "GS" => r.mode = IndicatorMode::Gross,
        "N" | "NT" => r.mode = IndicatorMode::Net,
        "M" => r.motion = true,
        _ => return None,
    }
    r.weight_g = Some(g);
    Some(r)
}

/// Frames the indicator byte stream. STX…ETX frames are returned as
/// `Frame::Stx`, CR/LF-terminated text outside a frame as `Frame::Line`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    Stx(String),
    Line(String),
}

#[derive(Default)]
pub struct ScaleFramer {
    buf: Vec<u8>,
    in_stx: bool,
}

const STX: u8 = 0x02;
const ETX: u8 = 0x03;

impl ScaleFramer {
    pub fn push(&mut self, bytes: &[u8]) -> Vec<Frame> {
        let mut out = Vec::new();
        for &b in bytes {
            match b {
                STX => {
                    self.buf.clear();
                    self.in_stx = true;
                }
                ETX if self.in_stx => {
                    out.push(Frame::Stx(String::from_utf8_lossy(&self.buf).into_owned()));
                    self.buf.clear();
                    self.in_stx = false;
                }
                b'\r' | b'\n' if !self.in_stx => {
                    if !self.buf.is_empty() {
                        out.push(Frame::Line(String::from_utf8_lossy(&self.buf).into_owned()));
                        self.buf.clear();
                    }
                }
                _ => {
                    if self.buf.len() < 128 {
                        self.buf.push(b);
                    } else {
                        self.buf.clear();
                        self.in_stx = false;
                    }
                }
            }
        }
        out
    }
}

pub fn parse_frame(protocol: ScaleProtocol, frame: &Frame) -> Option<Reading> {
    match (protocol, frame) {
        (ScaleProtocol::RinstrumAutoA, Frame::Stx(body)) => parse_rinstrum_auto_a(body),
        (ScaleProtocol::GenericLine, Frame::Line(line)) => parse_generic_line(line),
        _ => None,
    }
}

/// Encodes a Format A frame. Used only by the simulator so simulated weights
/// travel through exactly the same framer and parser as real ones.
pub fn encode_rinstrum_auto_a(r: &Reading) -> Vec<u8> {
    let status = if r.overload {
        'O'
    } else if r.underload {
        'U'
    } else if r.error {
        'E'
    } else if r.motion {
        'M'
    } else if r.mode == IndicatorMode::Net {
        'N'
    } else {
        'G'
    };
    let g = r.weight_g.unwrap_or(0);
    let sign = if g < 0 { '-' } else { ' ' };
    let abs = g.abs();
    // 2 decimals (10 g resolution) right-aligned in 7 chars.
    let weight = format!("{:>7}", format!("{}.{:02}", abs / 1000, (abs % 1000) / 10));
    let mut out = vec![STX];
    out.extend(format!("{sign}{weight}{status}").as_bytes());
    out.push(ETX);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kg_strings_become_exact_grams() {
        assert_eq!(parse_kg_to_grams("0027.50"), Some(27_500));
        assert_eq!(parse_kg_to_grams("-0.02"), Some(-20));
        assert_eq!(parse_kg_to_grams("  12.3"), Some(12_300));
        assert_eq!(parse_kg_to_grams("120"), Some(120_000));
        assert_eq!(parse_kg_to_grams("1.2345"), None);
        assert_eq!(parse_kg_to_grams("1,5"), None);
        assert_eq!(parse_kg_to_grams(""), None);
        assert_eq!(parse_kg_to_grams("."), None);
    }

    #[test]
    fn format_a_gross_and_flags() {
        let r = parse_rinstrum_auto_a("  127.55G").unwrap();
        assert_eq!(r.weight_g, Some(127_550));
        assert_eq!(r.mode, IndicatorMode::Gross);
        assert!(!r.motion);
        let m = parse_rinstrum_auto_a("   27.40M").unwrap();
        assert!(m.motion);
        let n = parse_rinstrum_auto_a("   27.40N").unwrap();
        assert_eq!(n.mode, IndicatorMode::Net);
        let neg = parse_rinstrum_auto_a("-   0.04G").unwrap();
        assert_eq!(neg.weight_g, Some(-40));
        let ol = parse_rinstrum_auto_a(" -------O").unwrap();
        assert!(ol.overload && ol.weight_g.is_none());
    }

    #[test]
    fn format_a_rejects_wrong_length_or_status() {
        assert!(parse_rinstrum_auto_a("  27.40G").is_none());
        assert!(parse_rinstrum_auto_a("   27.40X").is_none());
        assert!(parse_rinstrum_auto_a("   2x.40G").is_none());
    }

    #[test]
    fn generic_lines() {
        let r = parse_generic_line("ST,GS,+0027.50kg").unwrap();
        assert_eq!((r.weight_g, r.mode, r.motion), (Some(27_500), IndicatorMode::Gross, false));
        assert!(parse_generic_line("US,GS,+0027.50kg").unwrap().motion);
        assert_eq!(parse_generic_line("  27.50 kg G").unwrap().weight_g, Some(27_500));
        assert!(parse_generic_line("OL,GS,+9999.99kg").unwrap().overload);
        assert!(parse_generic_line("27.50 lb").is_none());
        assert!(parse_generic_line("hello").is_none());
    }

    #[test]
    fn framer_and_encoder_round_trip() {
        let reading = Reading {
            weight_g: Some(64_380),
            mode: IndicatorMode::Gross,
            motion: false,
            overload: false,
            underload: false,
            error: false,
        };
        let bytes = encode_rinstrum_auto_a(&reading);
        let mut f = ScaleFramer::default();
        let mut frames = f.push(&bytes[..4]);
        frames.extend(f.push(&bytes[4..]));
        assert_eq!(frames.len(), 1);
        assert_eq!(parse_frame(ScaleProtocol::RinstrumAutoA, &frames[0]), Some(reading));
    }

    #[test]
    fn framer_handles_lines_and_noise() {
        let mut f = ScaleFramer::default();
        let frames = f.push(b"ST,GS,+0001.00kg\r\n\x02   12.00G\x03");
        assert_eq!(frames, vec![Frame::Line("ST,GS,+0001.00kg".into()), Frame::Stx("   12.00G".into())]);
    }
}
