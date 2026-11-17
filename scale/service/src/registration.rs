//! Register Bins: measures one completely empty bin at a time and proposes
//! its RFID tag and tare (its gross weight) for a person to confirm.
//! Pure, like machine.rs: no I/O and no clock. The engine feeds it the same
//! indicator readings and tag reads as weighing, and while it runs the
//! weighing machine is paused, so registration can never create a weighing
//! or an employee credit.
//!
//! ```text
//! ClearScale ──empty for removal_ms──▶ Ready ──load──▶ Measuring (fixed 10 s cycle)
//! Measuring ──10 s: one tag, weight captured──▶ Proposed ──confirm──▶ Saving ──saved──▶ Saved
//! Measuring ──10 s: no tag──▶ Problem(NoTag) ──tag read while the bin is on──▶ Measuring (fresh 10 s)
//! Measuring ──no valid weight within capture_grace_ms──▶ Problem(WeightNotCaptured)
//! Saved ──empty for removal_ms──▶ Ready (next bin)
//! any loaded phase ──problem──▶ Problem(reason) ──resolved, or bin removed──▶ …
//! ```
//!
//! It follows the same fixed 10-second cycle as weighing (see machine.rs):
//! the countdown starts when the bin arrives; a tag read up to
//! `tag_window_ms` before that or at any time during the cycle is remembered
//! for it, even if the reader reports it only once; at 10 s the current
//! weight is captured with `capture_weight` (a flicker of a division or two
//! is accepted, nothing waits for a perfectly constant weight).
//!
//! What it refuses, whatever the person does:
//! * nothing is measured until the scale has read empty for `removal_ms`,
//!   on entry and after every bin, so a bin left on the scale (perhaps
//!   full) is never taken as a new empty bin;
//! * a weight below `min_load_g`, a weight that is not a steady gross weight
//!   at 10 s (or within `capture_grace_ms` after), or any indicator fault;
//! * no tag, or more than one tag, read for the bin;
//! * the previous bin's tag, unless it is read again while a bin is on the
//!   scale (a read as the previous bin is rolled away never names the next);
//! * confirming when the weight or tag has changed since the measurement.

use serde::Serialize;
use std::collections::{HashMap, VecDeque};

use crate::machine::{capture_weight, median, reading_ok, CaptureFail, Params};
use crate::scale_proto::{IndicatorMode, Reading};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    /// The registration id the server dedupes on. One per measurement, so a
    /// retried confirm of the same measurement is applied once.
    pub id: String,
    pub tag: String,
    pub gross_g: i64,
    pub samples_g: Vec<i64>,
    /// The window the weight was captured over (sent to the server as
    /// `stableMs`).
    pub stable_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum RegProblem {
    NoTag,
    MultipleTags { tags: Vec<String> },
    IndicatorNotGross,
    Overload,
    Underload,
    IndicatorError,
    /// No valid weight at the end of the 10 s cycle (nor within the grace).
    WeightNotCaptured { why: CaptureFail },
}

impl RegProblem {
    fn is_indicator(&self) -> bool {
        matches!(
            self,
            RegProblem::IndicatorNotGross | RegProblem::Overload | RegProblem::Underload | RegProblem::IndicatorError
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum RegPhase {
    #[serde(rename_all = "camelCase")]
    ClearScale { empty_since_ms: Option<u64> },
    Ready,
    /// The 10 s cycle for the bin on the scale. `tag` is the tag remembered
    /// for this bin so far (None: not read yet).
    #[serde(rename_all = "camelCase")]
    Measuring { since_ms: u64, tag: Option<String> },
    #[serde(rename_all = "camelCase")]
    Problem { reason: RegProblem, empty_since_ms: Option<u64> },
    Proposed { proposal: Proposal },
    Saving { proposal: Proposal },
    #[serde(rename_all = "camelCase")]
    Saved {
        bin_name: String,
        rfid_tag: String,
        tare_g: i64,
        empty_since_ms: Option<u64>,
    },
}

pub struct Registration {
    pub params: Params,
    pub phase: RegPhase,
    pub scale_online: bool,
    samples: VecDeque<(u64, Reading)>,
    last_reading: Option<Reading>,
    last_reading_ms: Option<u64>,
    /// tag -> last seen (ms)
    tags: HashMap<String, u64>,
    /// The single tag identified for the load now on the scale, kept until
    /// it is removed (the reader may report a tag only once).
    latched: Option<String>,
    /// The tag of the bin that was last on the scale. A read of it while
    /// the scale is empty (the bin being rolled away) is ignored.
    previous: Option<String>,
}

impl Registration {
    pub fn new(params: Params) -> Self {
        Self {
            params,
            phase: RegPhase::ClearScale { empty_since_ms: None },
            scale_online: false,
            samples: VecDeque::new(),
            last_reading: None,
            last_reading_ms: None,
            tags: HashMap::new(),
            latched: None,
            previous: None,
        }
    }

    pub fn last_reading(&self) -> Option<&Reading> {
        self.last_reading.as_ref()
    }

    pub fn on_tag(&mut self, tag: &str, now: u64) {
        if self.previous.as_deref() == Some(tag) && !self.is_loaded() {
            return;
        }
        self.tags.insert(tag.to_string(), now);
        match self.phase.clone() {
            RegPhase::Problem { reason: RegProblem::NoTag, .. } if self.is_loaded() => {
                // The tag finally read while the bin is on: a fresh 10 s cycle.
                self.latched = None;
                self.phase = RegPhase::Measuring { since_ms: now, tag: None };
                self.measure(now, now);
            }
            RegPhase::Measuring { since_ms, .. } => self.measure(since_ms, now),
            RegPhase::Proposed { proposal } if proposal.tag != tag => {
                self.phase = RegPhase::Problem {
                    reason: RegProblem::MultipleTags {
                        tags: vec![proposal.tag.clone(), tag.to_string()],
                    },
                    empty_since_ms: None,
                };
            }
            _ => {}
        }
    }

    pub fn on_reading(&mut self, reading: Reading, now: u64) {
        self.last_reading_ms = Some(now);
        self.scale_online = true;
        self.samples.push_back((now, reading.clone()));
        let keep_from = now.saturating_sub(self.params.capture_window_ms + 1_000);
        while matches!(self.samples.front(), Some((t, _)) if *t < keep_from) {
            self.samples.pop_front();
        }
        self.last_reading = Some(reading);
        self.advance(now);
    }

    pub fn tick(&mut self, now: u64) {
        let online = matches!(self.last_reading_ms, Some(t) if now.saturating_sub(t) <= self.params.scale_timeout_ms);
        if self.scale_online && !online && matches!(self.phase, RegPhase::Measuring { .. } | RegPhase::Proposed { .. }) {
            // Never propose (or keep proposing) a tare from data we no longer receive.
            self.forget_bin();
            self.phase = RegPhase::ClearScale { empty_since_ms: None };
        }
        self.scale_online = online;
        if online {
            self.advance(now);
        }
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

    /// A hard indicator condition. Motion (a Format A "M" frame carries no
    /// mode) is not one: it only matters at the moment the weight is
    /// captured, where `capture_weight` refuses anything but steady gross.
    fn indicator_problem(&self) -> Option<RegProblem> {
        let r = self.last_reading.as_ref()?;
        if r.overload {
            Some(RegProblem::Overload)
        } else if r.underload {
            Some(RegProblem::Underload)
        } else if r.error {
            Some(RegProblem::IndicatorError)
        } else if r.mode == IndicatorMode::Net {
            Some(RegProblem::IndicatorNotGross)
        } else {
            None
        }
    }

    /// Tags read for the load now on the scale: from `tag_window_ms` before
    /// its cycle started (the tag passes the reader as the bin rolls on).
    fn tags_since(&self, since_ms: u64) -> Vec<String> {
        let from = since_ms.saturating_sub(self.params.tag_window_ms);
        let mut t: Vec<String> = self.tags.iter().filter(|(_, at)| **at >= from).map(|(k, _)| k.clone()).collect();
        if let Some(l) = &self.latched {
            if !t.contains(l) {
                t.push(l.clone());
            }
        }
        t.sort();
        t
    }

    /// The bin on the scale is gone (or no longer trusted): its tag becomes
    /// the previous tag and is never carried over to the next bin.
    fn forget_bin(&mut self) {
        let tag = match &self.phase {
            RegPhase::Proposed { proposal } | RegPhase::Saving { proposal } => Some(proposal.tag.clone()),
            RegPhase::Saved { rfid_tag, .. } => Some(rfid_tag.clone()),
            _ => None,
        };
        if let Some(t) = tag.or_else(|| self.latched.clone()) {
            self.tags.remove(&t);
            self.previous = Some(t);
        }
        self.latched = None;
    }

    /// Returns Some(empty_since) while waiting for the scale to read empty
    /// long enough, and None once it has (tags seen before are then
    /// forgotten, so a stale read can't identify the next bin).
    fn clear_progress(&mut self, now: u64, empty_since_ms: Option<u64>) -> Option<Option<u64>> {
        if !self.is_empty() {
            return Some(None);
        }
        let since = empty_since_ms.unwrap_or(now);
        if now.saturating_sub(since) >= self.params.removal_ms {
            self.forget_bin();
            self.tags.retain(|_, seen| *seen >= since);
            return None;
        }
        Some(Some(since))
    }

    fn advance(&mut self, now: u64) {
        if self.last_reading.is_none() {
            return;
        }
        match self.phase.clone() {
            RegPhase::ClearScale { empty_since_ms } => match self.clear_progress(now, empty_since_ms) {
                Some(since) => self.phase = RegPhase::ClearScale { empty_since_ms: since },
                None => self.phase = RegPhase::Ready,
            },
            RegPhase::Saved {
                bin_name,
                rfid_tag,
                tare_g,
                empty_since_ms,
            } => match self.clear_progress(now, empty_since_ms) {
                Some(since) => {
                    self.phase = RegPhase::Saved {
                        bin_name,
                        rfid_tag,
                        tare_g,
                        empty_since_ms: since,
                    }
                }
                None => self.phase = RegPhase::Ready,
            },
            RegPhase::Ready => {
                if self.is_loaded() {
                    // The bin arrived: the fixed 10 s cycle starts now.
                    self.phase = RegPhase::Measuring { since_ms: now, tag: None };
                    self.measure(now, now);
                }
            }
            RegPhase::Measuring { since_ms, .. } => self.measure(since_ms, now),
            RegPhase::Problem { reason, empty_since_ms } => {
                if self.is_empty() {
                    match self.clear_progress(now, empty_since_ms) {
                        Some(since) => self.phase = RegPhase::Problem { reason, empty_since_ms: since },
                        None => self.phase = RegPhase::Ready,
                    }
                    return;
                }
                if empty_since_ms.is_some() {
                    self.phase = RegPhase::Problem { reason: reason.clone(), empty_since_ms: None };
                }
                // The indicator back to normal: measure afresh (the tag
                // already read for this bin is kept). No tag waits for a tag
                // read (see on_tag); the others wait for the scale to clear.
                if reason.is_indicator() && self.indicator_problem().is_none() && self.is_loaded() {
                    self.phase = RegPhase::Measuring { since_ms: now, tag: None };
                    self.measure(now, now);
                }
            }
            RegPhase::Proposed { proposal } => {
                if !self.is_loaded() {
                    // Bin taken off before anyone confirmed: start again
                    // with an empty scale.
                    self.forget_bin();
                    self.phase = RegPhase::ClearScale { empty_since_ms: None };
                    self.advance(now);
                } else if let Some(reason) = self.indicator_problem() {
                    self.phase = RegPhase::Problem { reason, empty_since_ms: None };
                } else if matches!(self.last_reading.as_ref(), Some(r) if reading_ok(r) && (r.weight_g.unwrap() - proposal.gross_g).abs() > self.params.capture_tolerance_g) {
                    // Something was added or taken out: measure again (the
                    // tag stays remembered for this bin).
                    self.phase = RegPhase::Measuring { since_ms: now, tag: Some(proposal.tag) };
                }
            }
            // The person confirmed this measurement; the save is in flight.
            RegPhase::Saving { .. } => {}
        }
    }

    fn measure(&mut self, since_ms: u64, now: u64) {
        if !self.is_loaded() {
            if self.is_empty() {
                // Taken off before it was measured: its tag is not reused.
                self.forget_bin();
                self.phase = RegPhase::ClearScale { empty_since_ms: None };
                self.advance(now);
            }
            return;
        }
        // Identify the load's tag first, so it is kept through an indicator problem.
        let tags = self.tags_since(since_ms);
        if tags.len() == 1 {
            self.latched = Some(tags[0].clone());
            if self.previous.as_deref() != Some(tags[0].as_str()) {
                self.previous = None;
            }
        }
        if tags.len() > 1 {
            self.phase = RegPhase::Problem {
                reason: RegProblem::MultipleTags { tags },
                empty_since_ms: None,
            };
            return;
        }
        if let Some(reason) = self.indicator_problem() {
            self.phase = RegPhase::Problem { reason, empty_since_ms: None };
            return;
        }
        let elapsed = now.saturating_sub(since_ms);
        if elapsed < self.params.settle_ms {
            self.phase = RegPhase::Measuring {
                since_ms,
                tag: self.latched.clone(),
            };
            return;
        }
        // 10 s: the tag must be known now. Never wait for it indefinitely.
        let Some(tag) = tags.into_iter().next() else {
            self.phase = RegPhase::Problem {
                reason: RegProblem::NoTag,
                empty_since_ms: None,
            };
            return;
        };
        let weights = match capture_weight(&self.samples, now, &self.params) {
            Ok(w) => w,
            Err(why) => {
                if elapsed >= self.params.settle_ms + self.params.capture_grace_ms {
                    self.phase = RegPhase::Problem {
                        reason: RegProblem::WeightNotCaptured { why },
                        empty_since_ms: None,
                    };
                } else {
                    self.phase = RegPhase::Measuring { since_ms, tag: Some(tag) };
                }
                return;
            }
        };
        self.phase = RegPhase::Proposed {
            proposal: Proposal {
                id: uuid::Uuid::new_v4().to_string(),
                tag,
                gross_g: median(&weights),
                samples_g: weights,
                stable_ms: self.params.capture_window_ms,
            },
        };
    }

    /// The person confirmed. Re-checks, at this moment, that the bin is
    /// still on the scale with the same gross weight and no other tag, then
    /// hands out the measurement to save.
    pub fn confirm(&mut self, now: u64) -> Result<Proposal, String> {
        let RegPhase::Proposed { proposal } = self.phase.clone() else {
            return Err("There is no measured bin to register. Place one empty bin on the scale.".into());
        };
        if !self.scale_online {
            return Err("The scale is not responding.".into());
        }
        if self.indicator_problem().is_some() {
            return Err("The indicator must be in gross mode with no error.".into());
        }
        let Some(r) = self.last_reading.clone().filter(reading_ok) else {
            return Err("The scale shows motion. Keep the bin still and press Register again.".into());
        };
        if (r.weight_g.unwrap() - proposal.gross_g).abs() > self.params.capture_tolerance_g {
            self.phase = RegPhase::Measuring {
                since_ms: now,
                tag: Some(proposal.tag.clone()),
            };
            return Err("The weight changed. Keep the bin still; it is being measured again.".into());
        }
        let others: Vec<String> = self.tags_since(now).into_iter().filter(|t| *t != proposal.tag).collect();
        if !others.is_empty() {
            self.on_tag(&others[0], now);
            return Err("Another tag was read. Only one bin can be on the scale.".into());
        }
        self.phase = RegPhase::Saving { proposal: proposal.clone() };
        Ok(proposal)
    }

    /// The server saved it. The bin must now be removed and the scale must
    /// return to zero before the next one.
    pub fn saved(&mut self, bin_name: String, rfid_tag: String, tare_g: i64) {
        self.phase = RegPhase::Saved {
            bin_name,
            rfid_tag,
            tare_g,
            empty_since_ms: None,
        };
    }

    /// The save was refused or failed: back to the same measurement (same
    /// registration id, so a retry is still applied once).
    pub fn save_failed(&mut self) {
        if let RegPhase::Saving { proposal } = self.phase.clone() {
            self.phase = RegPhase::Proposed { proposal };
        }
    }

    /// Time left until the weight is taken (0 outside a running cycle).
    pub fn settle_remaining_ms(&self, now: u64) -> u64 {
        match &self.phase {
            RegPhase::Measuring { since_ms, .. } => self.params.settle_ms.saturating_sub(now.saturating_sub(*since_ms)).div_ceil(100) * 100,
            _ => 0,
        }
    }

    pub fn clear_remaining_ms(&self, now: u64) -> u64 {
        match &self.phase {
            RegPhase::ClearScale { empty_since_ms: Some(s) }
            | RegPhase::Saved { empty_since_ms: Some(s), .. }
            | RegPhase::Problem { empty_since_ms: Some(s), .. } => self.params.removal_ms.saturating_sub(now.saturating_sub(*s)).div_ceil(100) * 100,
            _ => 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TAG: &str = "0000000182225750";
    const OTHER: &str = "0000000182225003";

    fn r(g: i64) -> Reading {
        Reading {
            weight_g: Some(g),
            mode: IndicatorMode::Gross,
            motion: false,
            overload: false,
            underload: false,
            error: false,
        }
    }

    struct T {
        reg: Registration,
        now: u64,
    }

    impl T {
        fn new() -> Self {
            Self {
                reg: Registration::new(Params::default()),
                now: 1_000_000,
            }
        }
        /// `secs` of 10 Hz readings.
        fn hold(&mut self, reading: Reading, secs: f64) {
            for _ in 0..(secs * 10.0) as u64 {
                self.now += 100;
                self.reg.on_reading(reading.clone(), self.now);
            }
        }
        fn tag(&mut self, t: &str) {
            self.reg.on_tag(t, self.now);
        }
        fn phase(&self) -> &str {
            match &self.reg.phase {
                RegPhase::ClearScale { .. } => "clear",
                RegPhase::Ready => "ready",
                RegPhase::Measuring { .. } => "measuring",
                RegPhase::Problem { .. } => "problem",
                RegPhase::Proposed { .. } => "proposed",
                RegPhase::Saving { .. } => "saving",
                RegPhase::Saved { .. } => "saved",
            }
        }
        fn proposal(&self) -> Proposal {
            match &self.reg.phase {
                RegPhase::Proposed { proposal } => proposal.clone(),
                p => panic!("not proposed: {p:?}"),
            }
        }
        fn problem(&self) -> RegProblem {
            match &self.reg.phase {
                RegPhase::Problem { reason, .. } => reason.clone(),
                p => panic!("no problem: {p:?}"),
            }
        }
    }

    #[test]
    fn an_empty_bin_on_a_cleared_scale_is_measured_and_proposed() {
        let mut t = T::new();
        t.hold(r(0), 2.5);
        assert_eq!(t.phase(), "ready");
        t.tag(TAG);
        t.hold(r(154_400), 9.0);
        assert_eq!(t.phase(), "measuring", "the full 10 s cycle runs first");
        t.hold(r(154_400), 3.0);
        let p = t.proposal();
        assert_eq!((p.tag.as_str(), p.gross_g), (TAG, 154_400));
        assert!(p.samples_g.len() >= 5);
    }

    #[test]
    fn a_bin_already_on_the_scale_is_never_measured_until_the_scale_is_cleared() {
        let mut t = T::new();
        t.tag(TAG);
        t.hold(r(172_500), 15.0); // a full bin left on the scale when Register Bins opened
        assert_eq!(t.phase(), "clear");
        t.hold(r(0), 1.0);
        assert_eq!(t.phase(), "clear", "must read zero for the full 2 s");
        t.hold(r(0), 1.5);
        assert_eq!(t.phase(), "ready");
    }

    #[test]
    fn no_tag_refuses_and_a_tag_read_while_it_is_still_on_the_scale_recovers() {
        let mut t = T::new();
        t.hold(r(0), 2.5);
        t.hold(r(154_400), 13.0);
        assert_eq!(t.problem(), RegProblem::NoTag);
        t.tag(TAG);
        t.hold(r(154_400), 13.0);
        assert_eq!(t.proposal().tag, TAG);
    }

    #[test]
    fn a_tag_read_before_the_scale_was_cleared_is_not_used() {
        let mut t = T::new();
        t.tag(TAG); // stale read from the previous bin
        t.hold(r(0), 2.5);
        t.now += 10_000;
        t.hold(r(154_400), 13.0);
        assert_eq!(t.problem(), RegProblem::NoTag);
    }

    #[test]
    fn two_tags_refuse_until_the_scale_is_cleared() {
        let mut t = T::new();
        t.hold(r(0), 2.5);
        t.tag(TAG);
        t.tag(OTHER);
        t.hold(r(154_400), 13.0);
        assert!(matches!(t.problem(), RegProblem::MultipleTags { .. }));
        t.hold(r(0), 2.5);
        assert_eq!(t.phase(), "ready");
    }

    #[test]
    fn net_mode_and_indicator_errors_refuse() {
        let mut t = T::new();
        t.hold(r(0), 2.5);
        t.tag(TAG);
        let mut net = r(154_400);
        net.mode = IndicatorMode::Net;
        t.hold(net, 13.0);
        assert_eq!(t.problem(), RegProblem::IndicatorNotGross);
        t.hold(r(154_400), 13.0);
        assert_eq!(t.phase(), "proposed", "back in gross mode it measures afresh");
        let mut over = r(154_400);
        over.overload = true;
        t.hold(over, 0.5);
        assert_eq!(t.problem(), RegProblem::Overload);
    }

    #[test]
    fn near_zero_is_never_a_bin() {
        let mut t = T::new();
        t.hold(r(0), 2.5);
        t.tag(TAG);
        t.hold(r(1_500), 20.0);
        assert_eq!(t.phase(), "ready");
    }

    fn moving_frame() -> Reading {
        // An R300 Format A "M" frame: motion, and no mode.
        Reading {
            mode: IndicatorMode::Unknown,
            motion: true,
            ..r(154_400)
        }
    }

    #[test]
    fn a_real_swing_or_motion_is_refused_with_a_reason_not_left_waiting() {
        let mut t = T::new();
        t.hold(r(0), 2.5);
        t.tag(TAG);
        for i in 0..120 {
            t.now += 100;
            t.reg.on_reading(r(154_400 + if i % 2 == 0 { 150 } else { -150 }), t.now);
        }
        assert_eq!(t.phase(), "measuring", "inside the 3 s grace after 10 s");
        for i in 0..40 {
            t.now += 100;
            t.reg.on_reading(r(154_400 + if i % 2 == 0 { 150 } else { -150 }), t.now);
        }
        assert_eq!(
            t.problem(),
            RegProblem::WeightNotCaptured {
                why: CaptureFail::Unsteady { spread_g: 300 }
            }
        );
        assert!(t.reg.confirm(t.now).is_err());
        // Sticky until the bin is taken off.
        t.hold(r(154_400), 15.0);
        assert_eq!(t.phase(), "problem");

        let mut t = T::new();
        t.hold(r(0), 2.5);
        t.tag(TAG);
        t.hold(moving_frame(), 9.0);
        assert_eq!(t.phase(), "measuring", "motion frames do not restart the 10 s");
        t.hold(moving_frame(), 5.0);
        assert_eq!(t.problem(), RegProblem::WeightNotCaptured { why: CaptureFail::Moving });
    }

    /// The reported case: 143.60 kg flickering by one 0.1 kg division, with
    /// an occasional motion frame, and tag 0000000137480620 read once as
    /// the bin rolled on and never again.
    #[test]
    fn the_reported_bin_is_proposed_at_ten_seconds() {
        let mut t = T::new();
        t.hold(r(0), 2.5);
        assert_eq!(t.phase(), "ready");
        t.tag("0000000137480620");
        t.hold(r(900), 0.3); // rolling on, still below the minimum load
        let arrived = t.now + 100;
        for i in 0..100 {
            t.now += 100;
            let reading = if i % 20 == 7 { moving_frame() } else { r(143_600 + if (i / 3) % 2 == 0 { 0 } else { 100 }) };
            t.reg.on_reading(reading, t.now);
        }
        match &t.reg.phase {
            RegPhase::Measuring { since_ms, tag } => {
                assert_eq!(*since_ms, arrived, "the countdown never restarted");
                assert_eq!(tag.as_deref(), Some("0000000137480620"), "remembered for this bin");
            }
            p => panic!("{p:?}"),
        }
        assert!(t.reg.settle_remaining_ms(t.now) <= 100);
        t.hold(r(143_600), 0.2);
        let p = t.proposal();
        assert_eq!(p.tag, "0000000137480620");
        assert!([143_600, 143_700].contains(&p.gross_g));
        // Confirm still works with the flicker going on.
        t.hold(r(143_700), 0.3);
        assert_eq!(t.reg.confirm(t.now).unwrap().tag, "0000000137480620");
    }

    #[test]
    fn a_tag_read_during_the_cycle_is_kept_and_the_countdown_runs_from_arrival() {
        let mut t = T::new();
        t.hold(r(0), 2.5);
        t.hold(r(154_400), 6.0);
        t.tag(TAG);
        t.hold(r(154_400), 3.9);
        assert_eq!(t.phase(), "measuring");
        t.hold(r(154_400), 0.2);
        assert_eq!(t.proposal().tag, TAG, "10 s after arrival, not after the tag");
    }

    #[test]
    fn the_previous_bin_tag_never_names_the_next_bin() {
        let mut t = T::new();
        t.hold(r(0), 2.5);
        t.tag(TAG);
        t.hold(r(154_400), 10.5);
        let p = t.reg.confirm(t.now).unwrap();
        t.reg.saved("Bin 77".into(), p.tag.clone(), p.gross_g);
        t.hold(r(0), 1.0);
        t.tag(TAG); // read again as it is rolled away, scale already empty
        t.hold(r(0), 1.5);
        assert_eq!(t.phase(), "ready");
        t.tag(TAG); // and once more after the scale cleared
        t.hold(r(150_000), 13.0); // the next bin, whose own tag is not read
        assert_eq!(t.problem(), RegProblem::NoTag);
        // Its own tag read while it is on the scale: measured afresh.
        t.tag(OTHER);
        t.hold(r(150_000), 10.5);
        assert_eq!(t.proposal().tag, OTHER);
    }

    #[test]
    fn a_bin_taken_off_mid_cycle_does_not_pass_its_tag_on() {
        let mut t = T::new();
        t.hold(r(0), 2.5);
        t.tag(TAG);
        t.hold(r(154_400), 4.0);
        t.hold(r(0), 2.5);
        assert_eq!(t.phase(), "ready");
        t.hold(r(150_000), 13.0);
        assert_eq!(t.problem(), RegProblem::NoTag);
    }

    #[test]
    fn a_weight_change_after_the_proposal_measures_again() {
        let mut t = T::new();
        t.hold(r(0), 2.5);
        t.tag(TAG);
        t.hold(r(154_400), 13.0);
        assert_eq!(t.phase(), "proposed");
        t.hold(r(160_000), 0.2);
        assert_eq!(t.phase(), "measuring");
        assert!(t.reg.confirm(t.now).is_err());
    }

    #[test]
    fn confirm_saves_once_then_requires_removal_and_zero() {
        let mut t = T::new();
        t.hold(r(0), 2.5);
        t.tag(TAG);
        t.hold(r(154_400), 13.0);
        let p = t.reg.confirm(t.now).unwrap();
        assert_eq!(t.phase(), "saving");
        assert!(t.reg.confirm(t.now).is_err(), "a second confirm has nothing to save");
        t.reg.saved("Bin 77".into(), p.tag.clone(), p.gross_g);
        t.hold(r(154_400), 30.0);
        assert_eq!(t.phase(), "saved", "still on the scale: no next measurement");
        t.tag(OTHER);
        t.hold(r(0), 1.0);
        t.hold(r(150_000), 1.0);
        assert_eq!(t.phase(), "saved", "a bin pushed on before zero is not measured");
        t.hold(r(0), 2.5);
        assert_eq!(t.phase(), "ready");
    }

    #[test]
    fn a_failed_save_keeps_the_same_measurement_and_registration_id() {
        let mut t = T::new();
        t.hold(r(0), 2.5);
        t.tag(TAG);
        t.hold(r(154_400), 13.0);
        let p = t.reg.confirm(t.now).unwrap();
        t.reg.save_failed();
        assert_eq!(t.proposal().id, p.id);
        t.hold(r(154_400), 0.5);
        assert_eq!(t.reg.confirm(t.now).unwrap().id, p.id);
    }

    #[test]
    fn a_second_tag_after_the_proposal_refuses() {
        let mut t = T::new();
        t.hold(r(0), 2.5);
        t.tag(TAG);
        t.hold(r(154_400), 13.0);
        t.tag(OTHER);
        assert!(matches!(t.problem(), RegProblem::MultipleTags { .. }));
        assert!(t.reg.confirm(t.now).is_err());
    }

    #[test]
    fn taking_the_bin_off_before_confirming_starts_over() {
        let mut t = T::new();
        t.hold(r(0), 2.5);
        t.tag(TAG);
        t.hold(r(154_400), 13.0);
        t.hold(r(0), 2.5);
        assert_eq!(t.phase(), "ready");
        assert!(t.reg.confirm(t.now).is_err());
    }

    #[test]
    fn scale_silence_drops_the_measurement() {
        let mut t = T::new();
        t.hold(r(0), 2.5);
        t.tag(TAG);
        t.hold(r(154_400), 13.0);
        t.now += 5_000;
        t.reg.tick(t.now);
        assert!(!t.reg.scale_online);
        assert_eq!(t.phase(), "clear");
    }
}
