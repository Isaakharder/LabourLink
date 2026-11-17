//! Weighing state machine. Pure: no I/O, no clock. The engine feeds it
//! indicator readings, RFID tag reads and ticks with a monotonic time in
//! milliseconds, and it returns a `Record` action exactly once per bin
//! placement that passes every check.
//!
//! Phases:
//!
//! ```text
//! Starting ──first reading──▶ Idle (scale empty) | AwaitingRemoval (load already on scale)
//! Idle ──load arrives──▶ Identifying (the fixed 10 s cycle starts now)
//! Identifying ──exactly one known, weighable tag──▶ Settling (same cycle, same start)
//! Identifying ──10 s and still no tag──▶ Blocked(NoTag)
//! Settling ──10 s since arrival──▶ Stabilizing ──weight captured──▶ AwaitingRemoval (Record emitted)
//! Stabilizing ──no valid weight within capture_grace_ms──▶ Blocked(WeightNotCaptured)
//! AwaitingRemoval ──scale empty for removal_ms──▶ Idle   (next bin)
//! any loaded phase ──problem──▶ Blocked(reason) ──resolved / removed──▶ …
//! ```
//!
//! The fixed 10-second cycle (shared with Register Bins, see `capture_weight`):
//! * the countdown starts when the bin arrives on the scale; a tag read up to
//!   `tag_window_ms` before that, or at any time during the cycle, belongs to
//!   it and is remembered even if the reader reports it only once;
//! * at 10 s the current weight is taken: the median of the steady gross
//!   readings of the last `capture_window_ms` (the 2 s before the 10 s
//!   mark), which must agree within `capture_tolerance_g`. A one-division
//!   flicker or a stray motion frame is accepted; nothing waits for the
//!   weight to become perfectly constant;
//! * if no valid weight arrives within `capture_grace_ms` after 10 s (motion,
//!   a real swing, not gross), the bin is refused with the reason shown. It
//!   never waits indefinitely.
//!
//! Duplicate prevention:
//! * one Record per placement: after recording, nothing is weighed again
//!   until the scale has read empty continuously for `removal_ms`;
//! * a carrier recorded within `duplicate_guard_ms` is blocked if it is
//!   placed again (lifted and put back) — the engine seeds this from SQLite
//!   so it survives a restart;
//! * a service (re)start with load already on the scale waits for removal
//!   instead of weighing a bin that may already have been recorded;
//! * tags read before the previous bin was removed are forgotten, so a stale
//!   read can never identify the next bin.

use serde::Serialize;
use std::collections::{HashMap, VecDeque};

use crate::scale_proto::{IndicatorMode, Reading};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Params {
    /// Fixed cycle length: the weight is taken this long after the bin
    /// arrives on the scale.
    pub settle_ms: u64,
    /// At the end of the cycle the weight is the median of the steady gross
    /// readings in this last window (at least `capture_min_samples`). The
    /// LabourLink server requires at least 2 s and 5 readings for a tare.
    pub capture_window_ms: u64,
    pub capture_min_samples: usize,
    /// Max spread (max − min) of those readings, in grams. Covers a flicker
    /// of a division; anything larger is a real swing and refused. Must stay
    /// under the server's 0.2 kg limit for a tare.
    pub capture_tolerance_g: i64,
    /// How long after the cycle ends a valid weight may still be taken (the
    /// indicator showed motion at exactly 10 s). Then the bin is refused.
    pub capture_grace_ms: u64,
    /// Gross at or above this means "something is on the scale".
    pub min_load_g: i64,
    /// Gross below this means "scale is empty".
    pub zero_threshold_g: i64,
    /// Scale must read empty this long before the next bin is accepted.
    pub removal_ms: u64,
    /// A tag counts for the bin on the scale if read within this window.
    pub tag_window_ms: u64,
    /// A net weight below this is treated as an empty bin and not recorded.
    pub min_net_g: i64,
    /// Same carrier cannot be recorded twice within this period.
    pub duplicate_guard_ms: u64,
    /// No reading for this long = indicator offline.
    pub scale_timeout_ms: u64,
}

impl Default for Params {
    fn default() -> Self {
        Self {
            settle_ms: 10_000,
            capture_window_ms: 2_000,
            capture_min_samples: 5,
            capture_tolerance_g: 150,
            capture_grace_ms: 3_000,
            min_load_g: 2_000,
            zero_threshold_g: 1_000,
            removal_ms: 2_000,
            tag_window_ms: 5_000,
            min_net_g: 500,
            duplicate_guard_ms: 5 * 60_000,
            scale_timeout_ms: 2_000,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CarrierInfo {
    pub id: String,
    pub name: String,
    pub rfid_tag: Option<String>,
    pub tare_g: i64,
    pub is_active: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinRef {
    pub carrier_id: String,
    pub carrier_name: String,
    pub tag: String,
    pub tare_g: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum BlockReason {
    NoTag,
    UnknownTag {
        tag: String,
    },
    MultipleTags {
        tags: Vec<String>,
    },
    CarrierInactive,
    TareMissing,
    RecentlyWeighed {
        seconds_ago: u64,
    },
    IndicatorNotGross,
    Overload,
    Underload,
    IndicatorError,
    EmptyBin {
        net_g: i64,
    },
    /// The weighing could not be written to SQLite, so it was NOT recorded.
    SaveFailed {
        message: String,
    },
    /// No valid weight at the end of the 10 s cycle (nor within the grace).
    WeightNotCaptured {
        why: CaptureFail,
    },
}

/// Why `capture_weight` could not take a weight.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum CaptureFail {
    /// The indicator reported motion on the latest reading, or on most of
    /// the window.
    Moving,
    /// Readings spread wider than `capture_tolerance_g`.
    #[serde(rename_all = "camelCase")]
    Unsteady { spread_g: i64 },
    /// Not an explicit gross weight (net, or a reading without a mode).
    NotGross,
    /// Overload, underload or an indicator error in the window.
    IndicatorFault,
    /// Fewer than `capture_min_samples` steady gross readings in the window.
    TooFewReadings { readings: usize },
}

impl BlockReason {
    /// Sticky reasons hold until the load is removed; the others are
    /// re-evaluated on every reading (a tag may still arrive, the carrier
    /// cache may be updated, the indicator condition may clear).
    fn sticky(&self) -> bool {
        matches!(
            self,
            BlockReason::MultipleTags { .. }
                | BlockReason::RecentlyWeighed { .. }
                | BlockReason::EmptyBin { .. }
                | BlockReason::SaveFailed { .. }
                | BlockReason::WeightNotCaptured { .. }
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RemovalReason {
    Recorded,
    StartupLoad,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum Phase {
    Starting,
    Idle,
    /// A load arrived and the 10 s cycle is running, but no tag has been
    /// read for it yet.
    #[serde(rename_all = "camelCase")]
    Identifying {
        started_ms: u64,
    },
    /// The bin is identified; `started_ms` is still when it arrived.
    #[serde(rename_all = "camelCase")]
    Settling {
        bin: BinRef,
        started_ms: u64,
    },
    #[serde(rename_all = "camelCase")]
    Stabilizing {
        bin: BinRef,
        since_ms: u64,
    },
    #[serde(rename_all = "camelCase")]
    AwaitingRemoval {
        reason: RemovalReason,
        bin: Option<BinRef>,
        empty_since_ms: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Blocked {
        reason: BlockReason,
        bin: Option<BinRef>,
        empty_since_ms: Option<u64>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct RecordDraft {
    pub bin: BinRef,
    pub gross_g: i64,
    pub net_g: i64,
    /// The stable-window weights the gross was taken from (median).
    pub samples_g: Vec<i64>,
}

pub trait CarrierLookup {
    fn by_tag(&self, tag: &str) -> Option<CarrierInfo>;
}

impl CarrierLookup for HashMap<String, CarrierInfo> {
    fn by_tag(&self, tag: &str) -> Option<CarrierInfo> {
        self.get(tag).cloned()
    }
}

pub struct Machine {
    pub params: Params,
    pub phase: Phase,
    pub scale_online: bool,
    last_reading_ms: Option<u64>,
    last_reading: Option<Reading>,
    samples: VecDeque<(u64, Reading)>,
    /// tag -> last seen (ms)
    tags: HashMap<String, u64>,
    /// carrier id -> recorded at (ms)
    recent: HashMap<String, u64>,
    /// Latest tag read regardless of phase (for the RFID registration screen).
    pub last_tag: Option<(String, u64)>,
    /// The single tag identified for the load currently on the scale. Kept
    /// until the load is removed, so a reader that reports a tag only once
    /// doesn't make the bin "lose" its identity while it waits.
    latched: Option<String>,
    /// Load came back while the scale was confirming it was empty (a bin
    /// swapped in too fast). Shown as a WAIT warning; cleared only when the
    /// scale has read empty for the full `removal_ms`.
    pub wait_for_zero: bool,
}

impl Machine {
    pub fn new(params: Params) -> Self {
        Self {
            params,
            phase: Phase::Starting,
            scale_online: false,
            last_reading_ms: None,
            last_reading: None,
            samples: VecDeque::new(),
            tags: HashMap::new(),
            recent: HashMap::new(),
            last_tag: None,
            latched: None,
            wait_for_zero: false,
        }
    }

    /// Marks a carrier as recorded `ago_ms` before `now` (restart recovery).
    pub fn seed_recent(&mut self, carrier_id: &str, now: u64, ago_ms: u64) {
        self.recent.insert(carrier_id.to_string(), now.saturating_sub(ago_ms));
    }

    /// The engine could not persist a Record: undo it so the bin is shown as
    /// not recorded and can be weighed again after it is lifted off.
    /// When the running cycle started (the bin arrived), if one is running.
    pub fn cycle_started_ms(&self) -> Option<u64> {
        match &self.phase {
            Phase::Identifying { started_ms } | Phase::Settling { started_ms, .. } => Some(*started_ms),
            _ => None,
        }
    }

    pub fn record_failed(&mut self, bin: BinRef, message: String) {
        self.recent.remove(&bin.carrier_id);
        self.phase = Phase::Blocked {
            reason: BlockReason::SaveFailed { message },
            bin: Some(bin),
            empty_since_ms: None,
        };
    }

    pub fn last_reading(&self) -> Option<&Reading> {
        self.last_reading.as_ref()
    }

    pub fn current_bin(&self) -> Option<&BinRef> {
        match &self.phase {
            Phase::Settling { bin, .. } | Phase::Stabilizing { bin, .. } => Some(bin),
            Phase::AwaitingRemoval { bin, .. } | Phase::Blocked { bin, .. } => bin.as_ref(),
            _ => None,
        }
    }

    pub fn on_tag(&mut self, tag: &str, now: u64) {
        self.tags.insert(tag.to_string(), now);
        self.last_tag = Some((tag.to_string(), now));
        if let Phase::Settling { bin, .. } | Phase::Stabilizing { bin, .. } = &self.phase {
            if bin.tag != tag {
                let tags = vec![bin.tag.clone(), tag.to_string()];
                let bin = Some(bin.clone());
                self.phase = Phase::Blocked {
                    reason: BlockReason::MultipleTags { tags },
                    bin,
                    empty_since_ms: None,
                };
            }
        }
    }

    pub fn tick(&mut self, now: u64, lookup: &dyn CarrierLookup) -> Option<RecordDraft> {
        let online = matches!(self.last_reading_ms, Some(t) if now.saturating_sub(t) <= self.params.scale_timeout_ms);
        if self.scale_online && !online {
            // Never finish a weighing on data we no longer receive.
            if matches!(self.phase, Phase::Identifying { .. } | Phase::Settling { .. } | Phase::Stabilizing { .. }) {
                self.go_idle();
            }
        }
        self.scale_online = online;
        if !online {
            return None;
        }
        self.advance(now, lookup)
    }

    pub fn on_reading(&mut self, reading: Reading, now: u64, lookup: &dyn CarrierLookup) -> Option<RecordDraft> {
        self.last_reading_ms = Some(now);
        self.scale_online = true;
        self.samples.push_back((now, reading.clone()));
        let keep_from = now.saturating_sub(self.params.capture_window_ms + 1_000);
        while matches!(self.samples.front(), Some((t, _)) if *t < keep_from) {
            self.samples.pop_front();
        }
        self.last_reading = Some(reading);
        self.advance(now, lookup)
    }

    fn weight(&self) -> Option<i64> {
        self.last_reading.as_ref().and_then(|r| r.weight_g)
    }

    fn is_empty(&self) -> bool {
        matches!(self.weight(), Some(w) if w < self.params.zero_threshold_g)
    }

    fn is_loaded(&self) -> bool {
        match &self.last_reading {
            Some(r) if r.overload => true,
            Some(r) => matches!(r.weight_g, Some(w) if w >= self.params.min_load_g),
            None => false,
        }
    }

    fn indicator_problem(&self) -> Option<BlockReason> {
        let r = self.last_reading.as_ref()?;
        if r.overload {
            Some(BlockReason::Overload)
        } else if r.underload {
            Some(BlockReason::Underload)
        } else if r.error {
            Some(BlockReason::IndicatorError)
        } else if r.mode == IndicatorMode::Net {
            Some(BlockReason::IndicatorNotGross)
        } else {
            None
        }
    }

    fn advance(&mut self, now: u64, lookup: &dyn CarrierLookup) -> Option<RecordDraft> {
        let Some(_) = &self.last_reading else { return None };
        match self.phase.clone() {
            Phase::Starting => {
                self.phase = if self.is_empty() {
                    Phase::Idle
                } else {
                    Phase::AwaitingRemoval {
                        reason: RemovalReason::StartupLoad,
                        bin: None,
                        empty_since_ms: None,
                    }
                };
                None
            }
            Phase::Idle => {
                if self.is_loaded() {
                    // The bin arrived: the fixed 10 s cycle starts now.
                    self.phase = self.identify(now, now, true, lookup);
                }
                None
            }
            Phase::Identifying { started_ms } => {
                if !self.is_loaded() {
                    if self.is_empty() {
                        self.go_idle(); // taken off before it was identified
                    }
                    return None;
                }
                self.phase = self.identify(started_ms, now, true, lookup);
                if matches!(self.phase, Phase::Settling { .. }) {
                    // Identified at or after the 10 s mark: take the weight now.
                    return self.advance(now, lookup);
                }
                None
            }
            Phase::Settling { bin, started_ms } => {
                if !self.is_loaded() {
                    self.go_idle(); // lifted off before the weight counted
                } else if let Some(reason) = self.indicator_problem() {
                    self.phase = Phase::Blocked {
                        reason,
                        bin: Some(bin),
                        empty_since_ms: None,
                    };
                } else if now.saturating_sub(started_ms) >= self.params.settle_ms {
                    self.phase = Phase::Stabilizing { bin, since_ms: now };
                    return self.try_record(now);
                }
                None
            }
            Phase::Stabilizing { bin, .. } => {
                if !self.is_loaded() {
                    self.go_idle();
                    None
                } else if let Some(reason) = self.indicator_problem() {
                    self.phase = Phase::Blocked {
                        reason,
                        bin: Some(bin),
                        empty_since_ms: None,
                    };
                    None
                } else {
                    self.try_record(now)
                }
            }
            Phase::AwaitingRemoval { reason, bin, empty_since_ms } => {
                if let Some(since) = self.removal_progress(now, empty_since_ms) {
                    self.phase = Phase::AwaitingRemoval {
                        reason,
                        bin,
                        empty_since_ms: Some(since),
                    };
                }
                None
            }
            Phase::Blocked { reason, bin, empty_since_ms } => {
                if let Some(since) = self.removal_progress(now, empty_since_ms) {
                    self.phase = Phase::Blocked {
                        reason: reason.clone(),
                        bin: bin.clone(),
                        empty_since_ms: Some(since),
                    };
                    return None;
                }
                if self.phase_is_idle() || reason.sticky() {
                    return None;
                }
                if !self.is_loaded() {
                    // Between the empty and loaded thresholds: hold.
                    return None;
                }
                // Re-check (a tag read late, the carrier cache updated, the
                // indicator back to gross). Anything that passes starts a
                // fresh full 10 s cycle from now. Still no tag stays NoTag:
                // it never silently restarts the countdown.
                let may_wait = !matches!(reason, BlockReason::NoTag);
                self.phase = self.identify(now, now, may_wait, lookup);
                None
            }
        }
    }

    fn go_idle(&mut self) {
        self.phase = Phase::Idle;
        self.latched = None;
        self.wait_for_zero = false;
    }

    fn phase_is_idle(&self) -> bool {
        matches!(self.phase, Phase::Idle)
    }

    /// Tracks continuous "empty" readings. Returns Some(empty_since) while
    /// waiting; switches to Idle (and returns None) once removal completes;
    /// returns None with the phase unchanged when the scale isn't empty.
    fn removal_progress(&mut self, now: u64, empty_since_ms: Option<u64>) -> Option<u64> {
        if !self.is_empty() {
            if empty_since_ms.is_some() {
                // Load came back before removal completed: restart the wait
                // and warn. Nothing is weighed until the scale reads empty for
                // the full removal period.
                self.wait_for_zero = true;
                match &mut self.phase {
                    Phase::AwaitingRemoval { empty_since_ms, .. } | Phase::Blocked { empty_since_ms, .. } => *empty_since_ms = None,
                    _ => {}
                }
            }
            return None;
        }
        let since = empty_since_ms.unwrap_or(now);
        if now.saturating_sub(since) >= self.params.removal_ms {
            // Forget every tag seen before the scale went empty, so a stale
            // read can't identify the next bin.
            self.tags.retain(|_, seen| *seen >= since);
            if let Some(bin) = self.current_bin().cloned() {
                self.tags.remove(&bin.tag);
            }
            self.go_idle();
            return None;
        }
        Some(since)
    }

    /// Identifies the load of the cycle that started at `started_ms`.
    /// Tags read from `tag_window_ms` before the cycle started count for it.
    /// With `may_wait`, no tag yet keeps the cycle running until 10 s.
    fn identify(&mut self, started_ms: u64, now: u64, may_wait: bool, lookup: &dyn CarrierLookup) -> Phase {
        let blocked = |reason, bin| Phase::Blocked {
            reason,
            bin,
            empty_since_ms: None,
        };
        if let Some(reason) = self.indicator_problem() {
            return blocked(reason, None);
        }
        let window_start = started_ms.saturating_sub(self.params.tag_window_ms);
        let mut present: Vec<String> = self.tags.iter().filter(|(_, t)| **t >= window_start).map(|(k, _)| k.clone()).collect();
        if let Some(l) = &self.latched {
            if !present.contains(l) {
                present.push(l.clone());
            }
        }
        present.sort();
        if present.len() == 1 {
            self.latched = Some(present[0].clone());
        }
        match present.len() {
            0 if may_wait && now.saturating_sub(started_ms) < self.params.settle_ms => Phase::Identifying { started_ms },
            0 => blocked(BlockReason::NoTag, None),
            1 => {
                let tag = present.remove(0);
                let Some(c) = lookup.by_tag(&tag) else {
                    return blocked(BlockReason::UnknownTag { tag }, None);
                };
                let bin = BinRef {
                    carrier_id: c.id.clone(),
                    carrier_name: c.name.clone(),
                    tag,
                    tare_g: c.tare_g,
                };
                if !c.is_active {
                    return blocked(BlockReason::CarrierInactive, Some(bin));
                }
                if c.tare_g <= 0 {
                    return blocked(BlockReason::TareMissing, Some(bin));
                }
                if let Some(at) = self.recent.get(&c.id) {
                    let ago = now.saturating_sub(*at);
                    if ago < self.params.duplicate_guard_ms {
                        return blocked(BlockReason::RecentlyWeighed { seconds_ago: ago / 1000 }, Some(bin));
                    }
                }
                Phase::Settling { bin, started_ms }
            }
            _ => blocked(BlockReason::MultipleTags { tags: present }, None),
        }
    }


    /// Weighing resumes after Register Bins: start over as if the service
    /// had just started (so a bin still on the scale must be removed first),
    /// keeping the duplicate guard.
    pub fn resume(&mut self) {
        self.phase = Phase::Starting;
        self.samples.clear();
        self.tags.clear();
        self.latched = None;
        self.wait_for_zero = false;
        self.last_reading = None;
        self.last_reading_ms = None;
        self.scale_online = false;
    }

    fn try_record(&mut self, now: u64) -> Option<RecordDraft> {
        let Phase::Stabilizing { bin, since_ms } = self.phase.clone() else { return None };
        let weights = match capture_weight(&self.samples, now, &self.params) {
            Ok(w) => w,
            Err(why) => {
                if now.saturating_sub(since_ms) >= self.params.capture_grace_ms {
                    self.phase = Phase::Blocked {
                        reason: BlockReason::WeightNotCaptured { why },
                        bin: Some(bin),
                        empty_since_ms: None,
                    };
                }
                return None;
            }
        };
        let gross_g = median(&weights);
        let net_g = gross_g - bin.tare_g;
        if net_g < self.params.min_net_g {
            self.phase = Phase::Blocked {
                reason: BlockReason::EmptyBin { net_g },
                bin: Some(bin),
                empty_since_ms: None,
            };
            return None;
        }
        self.recent.insert(bin.carrier_id.clone(), now);
        self.phase = Phase::AwaitingRemoval {
            reason: RemovalReason::Recorded,
            bin: Some(bin.clone()),
            empty_since_ms: None,
        };
        Some(RecordDraft {
            bin,
            gross_g,
            net_g,
            samples_g: weights,
        })
    }
}

/// A reading the cycle may take a weight from: an explicit, steady gross
/// weight with no indicator condition.
pub fn reading_ok(r: &Reading) -> bool {
    r.weight_g.is_some() && r.mode == IndicatorMode::Gross && !r.motion && !r.overload && !r.underload && !r.error
}

pub fn median(weights: &[i64]) -> i64 {
    let mut sorted = weights.to_vec();
    sorted.sort();
    sorted[sorted.len() / 2]
}

/// The capture rule shared by weighing and Register Bins, applied at the end
/// of the fixed 10 s cycle, over the readings of the last
/// `capture_window_ms`:
/// * any overload, underload, error or net reading refuses;
/// * the latest reading must be steady (no motion), and at most half the
///   window may be motion frames; a stray motion frame is left out, not a
///   reason to wait;
/// * every other reading must be an explicit gross weight;
/// * at least `capture_min_samples` steady gross readings, all within
///   `capture_tolerance_g` of each other.
///
/// Returns those steady gross weights; the caller takes their median.
pub fn capture_weight(samples: &VecDeque<(u64, Reading)>, now: u64, params: &Params) -> Result<Vec<i64>, CaptureFail> {
    let from = now.saturating_sub(params.capture_window_ms);
    let window: Vec<&Reading> = samples.iter().filter(|(t, _)| *t >= from && *t <= now).map(|(_, r)| r).collect();
    if window.iter().any(|r| r.overload || r.underload || r.error) {
        return Err(CaptureFail::IndicatorFault);
    }
    if window.iter().any(|r| r.mode == IndicatorMode::Net) {
        return Err(CaptureFail::NotGross);
    }
    let moving = window.iter().filter(|r| r.motion).count();
    if window.last().is_some_and(|r| r.motion) || moving * 2 > window.len() {
        return Err(CaptureFail::Moving);
    }
    if window.iter().any(|r| !r.motion && (r.mode != IndicatorMode::Gross || r.weight_g.is_none())) {
        return Err(CaptureFail::NotGross);
    }
    let weights: Vec<i64> = window.iter().filter(|r| reading_ok(r)).filter_map(|r| r.weight_g).collect();
    if weights.len() < params.capture_min_samples.max(1) {
        return Err(CaptureFail::TooFewReadings { readings: weights.len() });
    }
    let (min, max) = (*weights.iter().min().unwrap(), *weights.iter().max().unwrap());
    if max - min > params.capture_tolerance_g {
        return Err(CaptureFail::Unsteady { spread_g: max - min });
    }
    Ok(weights)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TAG_A: &str = "0000000182225750";
    const TAG_B: &str = "0000000182225751";
    const TAG_ZERO_TARE: &str = "0000000000000099";
    const TAG_INACTIVE: &str = "0000000000000098";

    fn carriers() -> HashMap<String, CarrierInfo> {
        let mut m = HashMap::new();
        for (id, name, tag, tare, active) in [
            ("c-a", "Bin 23", TAG_A, 27_500, true),
            ("c-b", "Bin 24", TAG_B, 27_000, true),
            ("c-z", "Bin 99", TAG_ZERO_TARE, 0, true),
            ("c-i", "Bin 98", TAG_INACTIVE, 27_000, false),
        ] {
            m.insert(
                tag.into(),
                CarrierInfo {
                    id: id.into(),
                    name: name.into(),
                    rfid_tag: Some(tag.into()),
                    tare_g: tare,
                    is_active: active,
                },
            );
        }
        m
    }

    fn gross(g: i64) -> Reading {
        Reading {
            weight_g: Some(g),
            mode: IndicatorMode::Gross,
            motion: false,
            overload: false,
            underload: false,
            error: false,
        }
    }

    fn moving(g: i64) -> Reading {
        Reading { motion: true, ..gross(g) }
    }

    /// Drives the machine with a reading every 100 ms from `from` to `to`
    /// (exclusive) and collects any records.
    fn feed(m: &mut Machine, c: &HashMap<String, CarrierInfo>, from: u64, to: u64, f: impl Fn(u64) -> Reading) -> Vec<RecordDraft> {
        let mut out = Vec::new();
        let mut t = from;
        while t < to {
            if let Some(r) = m.on_reading(f(t), t, c) {
                out.push(r);
            }
            t += 100;
        }
        out
    }

    fn started_empty(c: &HashMap<String, CarrierInfo>) -> Machine {
        let mut m = Machine::new(Params::default());
        feed(&mut m, c, 0, 1_000, |_| gross(0));
        assert_eq!(m.phase, Phase::Idle);
        m
    }

    #[test]
    fn happy_path_records_once_after_ten_second_settle_and_stable_window() {
        let c = carriers();
        let mut m = started_empty(&c);
        m.on_tag(TAG_A, 1_000);
        // Placed at 1.0 s, wobbles (motion) for 3 s then steady.
        let recs = feed(&mut m, &c, 1_000, 4_000, |t| moving(60_000 + (t as i64 % 700)));
        assert!(recs.is_empty());
        assert!(matches!(m.phase, Phase::Settling { .. }));
        let recs = feed(&mut m, &c, 4_000, 10_900, |_| gross(64_380));
        assert!(recs.is_empty(), "nothing may be recorded inside the 10 s settling period");
        let recs = feed(&mut m, &c, 10_900, 20_000, |t| gross(64_380 + (t as i64 % 3) * 10));
        assert_eq!(recs.len(), 1);
        let r = &recs[0];
        assert_eq!(r.bin.carrier_name, "Bin 23");
        assert_eq!(r.net_g, r.gross_g - 27_500);
        assert!((64_380..=64_400).contains(&r.gross_g));
        assert!(matches!(
            m.phase,
            Phase::AwaitingRemoval {
                reason: RemovalReason::Recorded,
                ..
            }
        ));
    }

    #[test]
    fn settling_period_is_ten_seconds_even_when_already_stable() {
        let c = carriers();
        let mut m = started_empty(&c);
        m.on_tag(TAG_A, 1_000);
        let recs = feed(&mut m, &c, 1_000, 10_950, |_| gross(64_000));
        assert!(recs.is_empty());
        let recs = feed(&mut m, &c, 10_950, 11_200, |_| gross(64_000));
        assert_eq!(recs.len(), 1, "records on the first reading after 10 s");
    }

    fn not_captured(m: &Machine) -> CaptureFail {
        match &m.phase {
            Phase::Blocked {
                reason: BlockReason::WeightNotCaptured { why },
                ..
            } => why.clone(),
            p => panic!("not WeightNotCaptured: {p:?}"),
        }
    }

    #[test]
    fn a_real_swing_is_refused_after_the_grace_instead_of_waiting_forever() {
        let c = carriers();
        let mut m = started_empty(&c);
        m.on_tag(TAG_A, 1_000);
        // Swings by 300 g (more than the 150 g tolerance) the whole time.
        let swing = |t: u64| gross(64_000 + ((t / 100) % 2) as i64 * 300);
        assert!(feed(&mut m, &c, 1_000, 13_900, swing).is_empty());
        assert!(matches!(m.phase, Phase::Stabilizing { .. }), "inside the 3 s grace");
        assert!(feed(&mut m, &c, 13_900, 60_000, swing).is_empty());
        assert_eq!(not_captured(&m), CaptureFail::Unsteady { spread_g: 300 });
        // Sticky while the bin stays; the scale clears normally afterwards.
        feed(&mut m, &c, 60_000, 63_000, |_| gross(0));
        assert_eq!(m.phase, Phase::Idle);
        // Motion flag alone also refuses, even with identical weights.
        let mut m = started_empty(&c);
        m.on_tag(TAG_A, 1_000);
        assert!(feed(&mut m, &c, 1_000, 30_000, |_| moving(64_000)).is_empty());
        assert_eq!(not_captured(&m), CaptureFail::Moving);
    }

    #[test]
    fn a_one_division_flicker_at_ten_seconds_is_captured_without_waiting() {
        let c = carriers();
        let mut m = started_empty(&c);
        m.on_tag(TAG_A, 1_000);
        // The indicator flickers between 143.60 and 143.70 kg (one 0.1 kg
        // division): the old 50 g stable window never accepted this.
        let flicker = |t: u64| gross(143_600 + ((t / 300) % 2) as i64 * 100);
        assert!(feed(&mut m, &c, 1_000, 11_000, flicker).is_empty());
        let recs = feed(&mut m, &c, 11_000, 11_200, flicker);
        assert_eq!(recs.len(), 1, "taken at the 10 s mark");
        assert!([143_600, 143_700].contains(&recs[0].gross_g));
    }

    #[test]
    fn motion_at_ten_seconds_is_captured_once_steady_within_the_grace() {
        let c = carriers();
        let mut m = started_empty(&c);
        m.on_tag(TAG_A, 1_000);
        feed(&mut m, &c, 1_000, 10_500, |_| gross(64_000));
        assert!(feed(&mut m, &c, 10_500, 12_000, |_| moving(64_000)).is_empty());
        let recs = feed(&mut m, &c, 12_000, 13_500, |_| gross(64_100));
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].gross_g, 64_100);
    }

    #[test]
    fn the_countdown_starts_at_arrival_and_a_tag_read_once_during_it_is_kept() {
        let c = carriers();
        let mut m = started_empty(&c);
        feed(&mut m, &c, 1_000, 6_000, |_| gross(64_000));
        assert_eq!(m.phase, Phase::Identifying { started_ms: 1_000 });
        m.on_tag(TAG_A, 6_000); // read once, never again
        assert!(feed(&mut m, &c, 6_000, 11_000, |_| gross(64_000)).is_empty());
        assert!(matches!(m.phase, Phase::Settling { started_ms: 1_000, .. }));
        let recs = feed(&mut m, &c, 11_000, 11_200, |_| gross(64_000));
        assert_eq!(recs.len(), 1, "weighed 10 s after arrival, not 10 s after the tag");
        assert_eq!(recs[0].bin.carrier_name, "Bin 23");
    }

    #[test]
    fn no_tag_is_reported_at_ten_seconds_and_a_late_tag_gets_a_fresh_cycle() {
        let c = carriers();
        let mut m = started_empty(&c);
        feed(&mut m, &c, 1_000, 10_900, |_| gross(64_000));
        assert!(matches!(m.phase, Phase::Identifying { .. }));
        feed(&mut m, &c, 10_900, 30_000, |_| gross(64_000));
        assert!(matches!(
            m.phase,
            Phase::Blocked {
                reason: BlockReason::NoTag,
                ..
            }
        ));
        m.on_tag(TAG_A, 30_000);
        assert!(feed(&mut m, &c, 30_000, 39_900, |_| gross(64_000)).is_empty());
        assert_eq!(feed(&mut m, &c, 39_900, 41_000, |_| gross(64_000)).len(), 1);
    }

    #[test]
    fn capture_requires_explicit_gross_and_enough_readings() {
        let p = Params::default();
        let at = |rs: Vec<(u64, Reading)>| capture_weight(&rs.into_iter().collect(), 10_000, &p);
        let unknown = Reading {
            mode: IndicatorMode::Unknown,
            ..gross(64_000)
        };
        let steady = |n: u64| (0..n).map(|i| (8_100 + i * 100, gross(64_000 + (i % 2) as i64 * 100))).collect::<Vec<_>>();
        assert_eq!(at(steady(19)).unwrap().len(), 19);
        let mut v = steady(19);
        v[3].1 = unknown;
        assert_eq!(at(v), Err(CaptureFail::NotGross));
        assert_eq!(at(steady(4)), Err(CaptureFail::TooFewReadings { readings: 4 }));
        // Readings older than the 2 s window do not count.
        let mut v = steady(19);
        v.insert(0, (7_000, gross(1)));
        assert_eq!(at(v).unwrap().len(), 19);
        // A stray motion frame is left out; motion on the latest reading or on
        // most of the window waits.
        let mut v = steady(19);
        v[5].1 = moving(64_000);
        assert_eq!(at(v).unwrap().len(), 18);
        let mut v = steady(19);
        v[18].1 = moving(64_000);
        assert_eq!(at(v), Err(CaptureFail::Moving));
        let v: Vec<_> = steady(19).into_iter().enumerate().map(|(i, (t, r))| (t, if i < 12 { moving(64_000) } else { r })).collect();
        assert_eq!(at(v), Err(CaptureFail::Moving));
    }

    #[test]
    fn repeated_tag_reads_while_on_scale_do_not_duplicate() {
        let c = carriers();
        let mut m = started_empty(&c);
        let mut recs = Vec::new();
        let mut t = 1_000;
        while t < 60_000 {
            if t % 500 == 0 {
                m.on_tag(TAG_A, t);
            }
            if let Some(r) = m.on_reading(gross(64_000), t, &c) {
                recs.push(r);
            }
            t += 100;
        }
        assert_eq!(recs.len(), 1);
    }

    #[test]
    fn next_bin_is_weighed_only_after_removal() {
        let c = carriers();
        let mut m = started_empty(&c);
        m.on_tag(TAG_A, 1_000);
        assert_eq!(feed(&mut m, &c, 1_000, 15_000, |_| gross(64_000)).len(), 1);
        // Bin B's tag is read while A is still on the scale: ignored.
        m.on_tag(TAG_B, 15_000);
        assert!(feed(&mut m, &c, 15_000, 16_000, |_| gross(64_000)).is_empty());
        // A removed briefly (under removal_ms) and load returns: still waiting.
        feed(&mut m, &c, 16_000, 17_000, |_| gross(0));
        feed(&mut m, &c, 17_000, 18_000, |_| gross(64_000));
        assert!(matches!(m.phase, Phase::AwaitingRemoval { .. }));
        // Fully removed.
        feed(&mut m, &c, 18_000, 20_500, |_| gross(0));
        assert_eq!(m.phase, Phase::Idle);
        // B placed with a fresh read.
        m.on_tag(TAG_B, 21_000);
        let recs = feed(&mut m, &c, 21_000, 35_000, |_| gross(58_000));
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].bin.carrier_name, "Bin 24");
    }

    #[test]
    fn stale_tag_from_before_removal_cannot_identify_next_bin() {
        let c = carriers();
        let mut m = started_empty(&c);
        m.on_tag(TAG_A, 1_000);
        assert_eq!(feed(&mut m, &c, 1_000, 15_000, |_| gross(64_000)).len(), 1);
        m.on_tag(TAG_B, 15_500); // B passes the antenna while A is still on the scale
        feed(&mut m, &c, 15_600, 18_000, |_| gross(0)); // A removed
        assert_eq!(m.phase, Phase::Idle);
        // An untagged/unread load arrives within the tag window of B's read.
        feed(&mut m, &c, 18_000, 19_000, |_| gross(60_000));
        assert_eq!(m.phase, Phase::Identifying { started_ms: 18_000 });
        feed(&mut m, &c, 19_000, 30_000, |_| gross(60_000));
        assert!(matches!(
            m.phase,
            Phase::Blocked {
                reason: BlockReason::NoTag,
                ..
            }
        ));
    }

    #[test]
    fn lift_and_replace_of_the_same_bin_is_blocked_as_duplicate() {
        let c = carriers();
        let mut m = started_empty(&c);
        m.on_tag(TAG_A, 1_000);
        assert_eq!(feed(&mut m, &c, 1_000, 15_000, |_| gross(64_000)).len(), 1);
        feed(&mut m, &c, 15_000, 18_000, |_| gross(0));
        m.on_tag(TAG_A, 18_000);
        let recs = feed(&mut m, &c, 18_000, 40_000, |_| gross(64_000));
        assert!(recs.is_empty());
        assert!(matches!(
            m.phase,
            Phase::Blocked {
                reason: BlockReason::RecentlyWeighed { .. },
                ..
            }
        ));
        // After the guard period a fresh placement is accepted again.
        feed(&mut m, &c, 40_000, 43_000, |_| gross(0));
        let later = 20_000 + Params::default().duplicate_guard_ms;
        m.on_tag(TAG_A, later);
        assert_eq!(feed(&mut m, &c, later, later + 14_000, |_| gross(64_000)).len(), 1);
    }

    #[test]
    fn restart_with_load_on_scale_waits_for_removal() {
        let c = carriers();
        let mut m = Machine::new(Params::default());
        m.on_tag(TAG_A, 0);
        let recs = feed(&mut m, &c, 0, 30_000, |_| gross(64_000));
        assert!(recs.is_empty());
        assert!(matches!(
            m.phase,
            Phase::AwaitingRemoval {
                reason: RemovalReason::StartupLoad,
                ..
            }
        ));
    }

    #[test]
    fn seeded_recent_weighing_blocks_after_restart() {
        let c = carriers();
        let mut m = started_empty(&c);
        m.seed_recent("c-a", 40_000, 30_000);
        m.on_tag(TAG_A, 40_000);
        assert!(feed(&mut m, &c, 40_000, 60_000, |_| gross(64_000)).is_empty());
        assert!(matches!(
            m.phase,
            Phase::Blocked {
                reason: BlockReason::RecentlyWeighed { seconds_ago: 30 },
                ..
            }
        ));
    }

    #[test]
    fn two_tags_block_and_stay_blocked_until_removal() {
        let c = carriers();
        let mut m = started_empty(&c);
        m.on_tag(TAG_A, 1_000);
        m.on_tag(TAG_B, 1_100);
        assert!(feed(&mut m, &c, 1_200, 30_000, |_| gross(120_000)).is_empty());
        assert!(matches!(
            m.phase,
            Phase::Blocked {
                reason: BlockReason::MultipleTags { .. },
                ..
            }
        ));
        // A second tag appearing during settling also aborts.
        let mut m = started_empty(&c);
        m.on_tag(TAG_A, 1_000);
        feed(&mut m, &c, 1_000, 5_000, |_| gross(64_000));
        m.on_tag(TAG_B, 5_000);
        assert!(feed(&mut m, &c, 5_000, 30_000, |_| gross(64_000)).is_empty());
        assert!(matches!(
            m.phase,
            Phase::Blocked {
                reason: BlockReason::MultipleTags { .. },
                ..
            }
        ));
    }

    #[test]
    fn unknown_inactive_and_zero_tare_bins_are_not_weighed() {
        let c = carriers();
        for (tag, want) in [("0000000000000001", "unknown"), (TAG_INACTIVE, "inactive"), (TAG_ZERO_TARE, "tare")] {
            let mut m = started_empty(&c);
            m.on_tag(tag, 1_000);
            assert!(feed(&mut m, &c, 1_000, 30_000, |_| gross(64_000)).is_empty(), "{want}");
            let ok = matches!(
                (&m.phase, want),
                (
                    Phase::Blocked {
                        reason: BlockReason::UnknownTag { .. },
                        ..
                    },
                    "unknown"
                ) | (
                    Phase::Blocked {
                        reason: BlockReason::CarrierInactive,
                        ..
                    },
                    "inactive"
                ) | (
                    Phase::Blocked {
                        reason: BlockReason::TareMissing,
                        ..
                    },
                    "tare"
                )
            );
            assert!(ok, "{want}: {:?}", m.phase);
        }
    }

    #[test]
    fn tag_registered_while_bin_waits_starts_settling() {
        let mut c = carriers();
        let mut m = started_empty(&c);
        m.on_tag("0000000000000001", 1_000);
        feed(&mut m, &c, 1_000, 3_000, |_| gross(64_000));
        assert!(matches!(
            m.phase,
            Phase::Blocked {
                reason: BlockReason::UnknownTag { .. },
                ..
            }
        ));
        c.insert(
            "0000000000000001".into(),
            CarrierInfo {
                id: "c-n".into(),
                name: "Bin 7".into(),
                rfid_tag: Some("0000000000000001".into()),
                tare_g: 27_000,
                is_active: true,
            },
        );
        m.on_tag("0000000000000001", 3_000);
        let recs = feed(&mut m, &c, 3_000, 16_000, |_| gross(64_000));
        assert_eq!(recs.len(), 1);
    }

    #[test]
    fn indicator_in_net_mode_or_overload_blocks() {
        let c = carriers();
        let mut m = started_empty(&c);
        m.on_tag(TAG_A, 1_000);
        let net = Reading {
            mode: IndicatorMode::Net,
            ..gross(37_000)
        };
        assert!(feed(&mut m, &c, 1_000, 30_000, |_| net.clone()).is_empty());
        assert!(matches!(
            m.phase,
            Phase::Blocked {
                reason: BlockReason::IndicatorNotGross,
                ..
            }
        ));
        let mut m = started_empty(&c);
        m.on_tag(TAG_A, 1_000);
        let over = Reading {
            weight_g: None,
            overload: true,
            ..gross(0)
        };
        assert!(feed(&mut m, &c, 1_000, 30_000, |_| over.clone()).is_empty());
        assert!(matches!(
            m.phase,
            Phase::Blocked {
                reason: BlockReason::Overload,
                ..
            }
        ));
    }

    #[test]
    fn empty_bin_is_not_recorded() {
        let c = carriers();
        let mut m = started_empty(&c);
        m.on_tag(TAG_A, 1_000);
        assert!(feed(&mut m, &c, 1_000, 30_000, |_| gross(27_600)).is_empty());
        assert!(matches!(
            m.phase,
            Phase::Blocked {
                reason: BlockReason::EmptyBin { net_g: 100 },
                ..
            }
        ));
    }

    #[test]
    fn lifting_the_bin_during_settling_records_nothing() {
        let c = carriers();
        let mut m = started_empty(&c);
        m.on_tag(TAG_A, 1_000);
        feed(&mut m, &c, 1_000, 6_000, |_| gross(64_000));
        feed(&mut m, &c, 6_000, 7_000, |_| gross(0));
        assert_eq!(m.phase, Phase::Idle);
    }

    #[test]
    fn scale_going_silent_aborts_settling_and_tick_reports_offline() {
        let c = carriers();
        let mut m = started_empty(&c);
        m.on_tag(TAG_A, 1_000);
        feed(&mut m, &c, 1_000, 9_000, |_| gross(64_000));
        assert!(m.tick(9_000, &c).is_none());
        assert!(m.scale_online);
        assert!(m.tick(12_000, &c).is_none());
        assert!(!m.scale_online);
        assert_eq!(m.phase, Phase::Idle);
    }

    #[test]
    fn randomized_sequences_never_record_a_placement_twice() {
        // Deterministic LCG so the test is reproducible without a rand crate.
        let c = carriers();
        let tags = [TAG_A, TAG_B];
        let mut seed: u64 = 0x5eed;
        let mut rnd = move |n: u64| {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (seed >> 33) % n
        };
        for _ in 0..200 {
            let mut m = started_empty(&c);
            let mut t = 1_000;
            let mut placements = 0u32;
            let mut records = 0u32;
            let mut loaded = false;
            let mut since_placed = 0u64;
            for _ in 0..600 {
                match rnd(100) {
                    0..=2 => {
                        loaded = !loaded;
                        if loaded {
                            placements += 1;
                            since_placed = 0;
                        }
                    }
                    3..=12 => m.on_tag(tags[rnd(2) as usize], t),
                    _ => {}
                }
                let w = if loaded { 60_000 + rnd(3) as i64 * 10 } else { 0 };
                if m.on_reading(gross(w), t, &c).is_some() {
                    records += 1;
                    assert!(since_placed >= 10_000, "recorded before the 10 s settle");
                }
                t += 100;
                since_placed += 100;
            }
            assert!(records <= placements, "records {records} > placements {placements}");
        }
    }

    #[test]
    fn next_bin_placed_before_zero_is_confirmed_warns_and_is_not_weighed() {
        let c = carriers();
        let mut m = started_empty(&c);
        m.on_tag(TAG_A, 1_000);
        assert_eq!(feed(&mut m, &c, 1_000, 15_000, |_| gross(64_000)).len(), 1);
        assert!(!m.wait_for_zero);
        // Bin A lifted off; Bin B goes on after only 1 s of empty readings.
        feed(&mut m, &c, 15_000, 16_000, |_| gross(0));
        assert!(!m.wait_for_zero, "no warning while the scale is simply empty");
        m.on_tag(TAG_B, 16_000);
        let recs = feed(&mut m, &c, 16_000, 40_000, |_| gross(58_000));
        assert!(recs.is_empty(), "nothing is weighed until the scale has returned to zero");
        assert!(m.wait_for_zero);
        assert!(matches!(m.phase, Phase::AwaitingRemoval { .. }));
        // Still warning during a second, still-too-short empty spell.
        feed(&mut m, &c, 40_000, 41_000, |_| gross(0));
        assert!(m.wait_for_zero);
        // Scale reads empty for the full 2 s: warning clears, station is ready.
        feed(&mut m, &c, 41_000, 43_100, |_| gross(0));
        assert!(!m.wait_for_zero);
        assert_eq!(m.phase, Phase::Idle);
        // Bin B weighed normally from here.
        m.on_tag(TAG_B, 44_000);
        let recs = feed(&mut m, &c, 44_000, 58_000, |_| gross(58_000));
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].bin.carrier_name, "Bin 24");
    }

    #[test]
    fn duplicate_guard_still_applies_after_a_zero_wait() {
        let c = carriers();
        let mut m = started_empty(&c);
        m.on_tag(TAG_A, 1_000);
        assert_eq!(feed(&mut m, &c, 1_000, 15_000, |_| gross(64_000)).len(), 1);
        feed(&mut m, &c, 15_000, 15_500, |_| gross(0));
        feed(&mut m, &c, 15_500, 17_000, |_| gross(64_000)); // same bin back on too soon
        assert!(m.wait_for_zero);
        feed(&mut m, &c, 17_000, 19_500, |_| gross(0));
        assert!(!m.wait_for_zero);
        m.on_tag(TAG_A, 20_000);
        assert!(feed(&mut m, &c, 20_000, 40_000, |_| gross(64_000)).is_empty());
        assert!(matches!(
            m.phase,
            Phase::Blocked {
                reason: BlockReason::RecentlyWeighed { .. },
                ..
            }
        ));
    }
}
