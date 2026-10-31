//! Register Bins: measures one completely empty bin at a time and proposes
//! its RFID tag and tare (its stable gross weight) for a person to confirm.
//! Pure, like machine.rs: no I/O and no clock. The engine feeds it the same
//! indicator readings and tag reads as weighing, and while it runs the
//! weighing machine is paused, so registration can never create a weighing.
//!
//! ```text
//! ClearScale ──empty for removal_ms──▶ Ready ──load──▶ Measuring (10 s settle, then stable window)
//! Measuring ──stable, gross, exactly one tag──▶ Proposed ──confirm──▶ Saving ──saved──▶ Saved
//! Saved ──empty for removal_ms──▶ Ready (next bin)
//! any loaded phase ──problem──▶ Problem(reason) ──resolved, or bin removed──▶ …
//! ```
//!
//! What it refuses, whatever the person does:
//! * nothing is measured until the scale has read empty for `removal_ms`,
//!   on entry and after every bin, so a bin left on the scale (perhaps
//!   full) is never taken as a new empty bin;
//! * a weight below `min_load_g`, an unstable weight, or any indicator mode
//!   other than gross;
//! * no tag, or more than one tag, read for the bin;
//! * confirming when the weight or tag has changed since the measurement.
//!
//! The RFID reader behaves as it does for weighing (it may not report the
//! same tag again until another tag has been read in between); this module
//! does not try to make it re-read.

use serde::Serialize;
use std::collections::{HashMap, VecDeque};

use crate::machine::{stable_weights, Params};
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
    #[serde(rename_all = "camelCase")]
    Measuring { since_ms: u64 },
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
        }
    }

    pub fn last_reading(&self) -> Option<&Reading> {
        self.last_reading.as_ref()
    }

    pub fn on_tag(&mut self, tag: &str, now: u64) {
        self.tags.insert(tag.to_string(), now);
        if matches!(self.phase, RegPhase::Problem { reason: RegProblem::NoTag, .. }) && self.is_loaded() {
            // The tag finally read: measure the bin afresh.
            self.phase = RegPhase::Measuring { since_ms: now };
            return;
        }
        if let RegPhase::Proposed { proposal } = &self.phase {
            if proposal.tag != tag {
                self.phase = RegPhase::Problem {
                    reason: RegProblem::MultipleTags {
                        tags: vec![proposal.tag.clone(), tag.to_string()],
                    },
                    empty_since_ms: None,
                };
            }
        }
    }

    pub fn on_reading(&mut self, reading: Reading, now: u64) {
        self.last_reading_ms = Some(now);
        self.scale_online = true;
        self.samples.push_back((now, reading.clone()));
        let keep_from = now.saturating_sub(self.params.stable_window_ms + 1_000);
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

    fn indicator_problem(&self) -> Option<RegProblem> {
        let r = self.last_reading.as_ref()?;
        if r.overload {
            Some(RegProblem::Overload)
        } else if r.underload {
            Some(RegProblem::Underload)
        } else if r.error {
            Some(RegProblem::IndicatorError)
        } else if r.mode != IndicatorMode::Gross {
            Some(RegProblem::IndicatorNotGross)
        } else {
            None
        }
    }

    /// Tags read for the load now on the scale: from `tag_window_ms` before
    /// it arrived (the tag passes the reader as the bin rolls on).
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

    /// Returns Some(empty_since) while waiting for the scale to read empty
    /// long enough, and None once it has (tags seen before are then
    /// forgotten, so a stale read can't identify the next bin).
    fn clear_progress(&mut self, now: u64, empty_since_ms: Option<u64>) -> Option<Option<u64>> {
        if !self.is_empty() {
            return Some(None);
        }
        let since = empty_since_ms.unwrap_or(now);
        if now.saturating_sub(since) >= self.params.removal_ms {
            self.tags.retain(|_, seen| *seen >= since);
            self.latched = None;
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
                    self.phase = RegPhase::Measuring { since_ms: now };
                    self.measure(now, now);
                }
            }
            RegPhase::Measuring { since_ms } => self.measure(since_ms, now),
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
                // The indicator back to gross with no error: measure afresh.
                // (No tag waits for a tag read, see on_tag; two tags wait
                // for the scale to be cleared.)
                if reason.is_indicator() && self.indicator_problem().is_none() && self.is_loaded() {
                    self.phase = RegPhase::Measuring { since_ms: now };
                    self.measure(now, now);
                }
            }
            RegPhase::Proposed { proposal } => {
                if !self.is_loaded() {
                    // Bin taken off before anyone confirmed: start again
                    // with an empty scale.
                    self.phase = RegPhase::ClearScale { empty_since_ms: None };
                    self.advance(now);
                } else if let Some(reason) = self.indicator_problem() {
                    self.phase = RegPhase::Problem { reason, empty_since_ms: None };
                } else if matches!(self.weight(), Some(w) if (w - proposal.gross_g).abs() > self.params.stable_tolerance_g) {
                    // Something was added or taken out: measure again.
                    self.phase = RegPhase::Measuring { since_ms: now };
                }
            }
            // The person confirmed this measurement; the save is in flight.
            RegPhase::Saving { .. } => {}
        }
    }

    fn measure(&mut self, since_ms: u64, now: u64) {
        if !self.is_loaded() {
            if self.is_empty() {
                self.phase = RegPhase::Ready;
            }
            return;
        }
        // Identify the load's tag first, so it is kept through an indicator problem.
        let tags = self.tags_since(since_ms);
        if tags.len() == 1 {
            self.latched = Some(tags[0].clone());
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
        if now.saturating_sub(since_ms) < self.params.settle_ms {
            return;
        }
        let Some(weights) = stable_weights(&self.samples, now, &self.params) else { return };
        let Some(tag) = tags.into_iter().next() else {
            self.phase = RegPhase::Problem {
                reason: RegProblem::NoTag,
                empty_since_ms: None,
            };
            return;
        };
        let mut sorted = weights.clone();
        sorted.sort();
        let gross_g = sorted[sorted.len() / 2];
        self.phase = RegPhase::Proposed {
            proposal: Proposal {
                id: uuid::Uuid::new_v4().to_string(),
                tag,
                gross_g,
                samples_g: weights,
                stable_ms: self.params.stable_window_ms,
            },
        };
    }

    /// The person confirmed. Re-checks, at this moment, that the bin is
    /// still on the scale with the same stable gross weight and no other
    /// tag, then hands out the measurement to save.
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
        let stable = stable_weights(&self.samples, now, &self.params);
        let still = matches!(&stable, Some(w) if w.iter().all(|g| (g - proposal.gross_g).abs() <= self.params.stable_tolerance_g));
        if !still {
            self.phase = RegPhase::Measuring { since_ms: now };
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

    pub fn settle_remaining_ms(&self, now: u64) -> u64 {
        match &self.phase {
            RegPhase::Measuring { since_ms } => self.params.settle_ms.saturating_sub(now.saturating_sub(*since_ms)).div_ceil(100) * 100,
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
        assert_eq!(t.phase(), "measuring", "the full 10 s settle runs first");
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

    #[test]
    fn an_unstable_weight_is_never_proposed() {
        let mut t = T::new();
        t.hold(r(0), 2.5);
        t.tag(TAG);
        for i in 0..200 {
            t.now += 100;
            t.reg.on_reading(r(154_400 + if i % 2 == 0 { 100 } else { -100 }), t.now);
        }
        assert_eq!(t.phase(), "measuring");
        let mut moving = r(154_400);
        moving.motion = true;
        t.hold(moving, 5.0);
        assert_eq!(t.phase(), "measuring");
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
