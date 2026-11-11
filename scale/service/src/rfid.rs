//! PROTAGD RFID reader (FTDI FT230X, 9600 8N1) line parsing.
//!
//! The reader emits one ASCII line per read, e.g. `R 0000 0000000182225750`.
//! Observed so far: an `R` record marker, a 4-digit field (reader/antenna
//! id, not yet confirmed) and the tag identifier. Only lines matching that
//! shape exactly are accepted; anything else is reported as unparsed so the
//! capture tool can show it, but it never identifies a bin.
//!
//! Tag identifiers are opaque text: leading zeros are significant. The
//! normalization rule is a port of server/src/lib/rfidTag.ts so a tag read
//! here compares equal to `carriers.rfid_tag` (065_carrier_rfid_tag.sql).

pub const MAX_RFID_TAG_LENGTH: usize = 64;

/// Same rule as `normalizeRfidTag` on the server: drop all whitespace, uppercase.
pub fn normalize_rfid_tag(raw: &str) -> String {
    raw.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_uppercase()
}

/// Same rule as `parseRfidTag` on the server (chk_carriers_rfid_tag_format).
pub fn is_valid_rfid_tag(tag: &str) -> bool {
    !tag.is_empty() && tag.len() <= MAX_RFID_TAG_LENGTH && tag.chars().all(|c| c.is_ascii_digit() || c.is_ascii_uppercase())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagRead {
    pub reader_field: String,
    pub tag: String,
}

/// Parses one line (without its line terminator). Returns None for any line
/// that isn't exactly `R <4 digits> <tag>`.
pub fn parse_protagd_line(line: &str) -> Option<TagRead> {
    let line = line.trim_matches(|c: char| c == '\r' || c == '\n' || c == '\0').trim();
    let mut parts = line.split_whitespace();
    if parts.next()? != "R" {
        return None;
    }
    let reader_field = parts.next()?;
    let raw_tag = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    if reader_field.len() != 4 || !reader_field.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let tag = normalize_rfid_tag(raw_tag);
    if !is_valid_rfid_tag(&tag) {
        return None;
    }
    Some(TagRead {
        reader_field: reader_field.to_string(),
        tag,
    })
}

/// Splits a byte stream into lines on CR and/or LF.
#[derive(Default)]
pub struct LineFramer {
    buf: Vec<u8>,
}

impl LineFramer {
    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        let mut out = Vec::new();
        for &b in bytes {
            if b == b'\r' || b == b'\n' {
                if !self.buf.is_empty() {
                    out.push(String::from_utf8_lossy(&self.buf).into_owned());
                    self.buf.clear();
                }
            } else if self.buf.len() < 256 {
                self.buf.push(b);
            } else {
                // Runaway line with no terminator: drop it rather than grow forever.
                self.buf.clear();
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_observed_format_keeping_leading_zeros() {
        let r = parse_protagd_line("R 0000 0000000182225750").unwrap();
        assert_eq!(r.tag, "0000000182225750");
        assert_eq!(r.reader_field, "0000");
    }

    #[test]
    fn tolerates_line_endings_and_extra_spacing() {
        assert_eq!(parse_protagd_line("R  0000   0000000182225750\r").unwrap().tag, "0000000182225750");
    }

    #[test]
    fn uppercases_hex_style_tags_like_the_server() {
        assert_eq!(parse_protagd_line("R 0001 e2003412abcd").unwrap().tag, "E2003412ABCD");
    }

    #[test]
    fn rejects_anything_not_matching_the_shape() {
        for bad in ["", "R", "R 0000", "X 0000 123", "R 00 123", "R 0000 12-34", "R 0000 123 extra", "garbage"] {
            assert!(parse_protagd_line(bad).is_none(), "{bad:?} should not parse");
        }
        assert!(parse_protagd_line(&format!("R 0000 {}", "1".repeat(65))).is_none());
    }

    #[test]
    fn normalization_matches_server_rule() {
        assert_eq!(normalize_rfid_tag(" 0000 0001 8222 5750 \n"), "0000000182225750");
        assert!(is_valid_rfid_tag("0000000182225750"));
        assert!(!is_valid_rfid_tag("abc"));
    }

    #[test]
    fn framer_splits_on_cr_lf_and_partial_chunks() {
        let mut f = LineFramer::default();
        assert!(f.push(b"R 0000 00000").is_empty());
        assert_eq!(f.push(b"00182225750\r\nR 0000 1\r"), vec!["R 0000 0000000182225750", "R 0000 1"]);
    }
}
