//! Employee assignment rule for a weighing — the reference implementation.
//!
//! The station never decides who gets credit. The LabourLink server does,
//! from evidence only it has (phone bin-switch events synced through
//! `mobile_time_events`). This module is the executable specification of
//! that rule: the simulator's in-process server runs it, and the server-side
//! port (docs/ARCHITECTURE.md §5) must pass the same cases.
//!
//! A bin-use cycle for carrier X weighed at T is the half-open interval
//! (previous weighing of X, T]. Every weighing (credited, pending, under
//! review or expired) closes a cycle, so consecutive uses of the same bin
//! are independent. A *claim* is a verified phone event in which an employee
//! switched to bin X. Then:
//!
//! * exactly one employee has claims in the cycle → **credited** to them,
//!   and those claims are consumed (one claim can never credit two weighings);
//! * no claims yet → **pending**, re-evaluated whenever claims arrive (late
//!   phone syncs) for up to 24 hours after the weighing;
//! * still none 24 hours after the weighing → **expired**: permanently
//!   discarded, never credited and never assignable. Only its time is kept,
//!   as the boundary of the bin's next cycle;
//! * two or more employees → **needs review**, nobody credited.
//!
//! Credited, needs review and expired are final: no later phone sync changes
//! them. A late claim from a *different* employee inside an already credited
//! cycle is reported in `Decision::conflicts` so it can be flagged for a
//! supervisor; the original credit stays exactly as it was. Any correction
//! is an explicit, audited administrator action outside this rule.
//!
//! Claims whose phone clock was flagged unreliable never count.

use serde::Serialize;

pub const PENDING_RECOVERY_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AssignmentStatus {
    Credited,
    Pending,
    NeedsReview,
    Expired,
}

impl AssignmentStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            AssignmentStatus::Credited => "credited",
            AssignmentStatus::Pending => "pending",
            AssignmentStatus::NeedsReview => "needs_review",
            AssignmentStatus::Expired => "expired",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Claim {
    pub id: String,
    pub employee_id: String,
    pub carrier_id: String,
    /// Phone's occurred-at time, ms since epoch.
    pub occurred_at: i64,
    /// False when the server flagged the phone clock (backwards jump,
    /// future-clamped). Such claims never credit anyone.
    pub clock_trusted: bool,
    /// Weighing this claim was consumed by, if any.
    pub consumed_by: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WeighingFacts {
    pub id: String,
    pub carrier_id: String,
    pub weighed_at: i64,
    /// Previous weighing of the same carrier (any status), ms since epoch.
    pub previous_weighed_at: Option<i64>,
    pub current: Option<AssignmentStatus>,
    pub current_employee: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Decision {
    pub status: AssignmentStatus,
    pub employee_id: Option<String>,
    /// Claims to mark consumed by this weighing (only when credited).
    pub consume: Vec<String>,
    /// Claims from other employees inside this already credited cycle. They
    /// change nothing; the server flags them for supervisor review.
    pub conflicts: Vec<String>,
    pub pending_until: Option<i64>,
}

pub fn in_cycle(w: &WeighingFacts, c: &Claim) -> bool {
    c.carrier_id == w.carrier_id && c.occurred_at <= w.weighed_at && w.previous_weighed_at.is_none_or(|prev| c.occurred_at > prev)
}

pub fn decide(w: &WeighingFacts, claims: &[Claim], now: i64) -> Decision {
    let eligible: Vec<&Claim> = claims
        .iter()
        .filter(|c| in_cycle(w, c) && c.clock_trusted)
        .filter(|c| c.consumed_by.is_none() || c.consumed_by.as_deref() == Some(w.id.as_str()))
        .collect();
    let unchanged = |status| Decision {
        status,
        employee_id: None,
        consume: vec![],
        conflicts: vec![],
        pending_until: None,
    };

    match w.current {
        // Final: a credit never changes. Further scans of the bin by the
        // credited employee in this cycle are absorbed; scans by anyone else
        // are reported as conflicts for supervisor review.
        Some(AssignmentStatus::Credited) => {
            let credited = w.current_employee.as_deref();
            let (same, other): (Vec<&Claim>, Vec<&Claim>) = eligible.into_iter().partition(|c| Some(c.employee_id.as_str()) == credited);
            return Decision {
                status: AssignmentStatus::Credited,
                employee_id: w.current_employee.clone(),
                consume: same.iter().filter(|c| c.consumed_by.is_none()).map(|c| c.id.clone()).collect(),
                conflicts: other.iter().map(|c| c.id.clone()).collect(),
                pending_until: None,
            };
        }
        Some(s @ (AssignmentStatus::Expired | AssignmentStatus::NeedsReview)) => return unchanged(s),
        _ => {}
    }

    let mut employees: Vec<&str> = eligible.iter().map(|c| c.employee_id.as_str()).collect();
    employees.sort();
    employees.dedup();

    let pending_until = w.weighed_at + PENDING_RECOVERY_MS;
    match employees.len() {
        0 if now >= pending_until => unchanged(AssignmentStatus::Expired),
        0 => Decision {
            pending_until: Some(pending_until),
            ..unchanged(AssignmentStatus::Pending)
        },
        1 => Decision {
            status: AssignmentStatus::Credited,
            employee_id: Some(employees[0].to_string()),
            consume: eligible.iter().map(|c| c.id.clone()).collect(),
            conflicts: vec![],
            pending_until: None,
        },
        _ => unchanged(AssignmentStatus::NeedsReview),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const H: i64 = 60 * 60 * 1000;
    const M: i64 = 60 * 1000;

    fn claim(id: &str, emp: &str, carrier: &str, at: i64) -> Claim {
        Claim {
            id: id.into(),
            employee_id: emp.into(),
            carrier_id: carrier.into(),
            occurred_at: at,
            clock_trusted: true,
            consumed_by: None,
        }
    }

    fn weighing(id: &str, at: i64, prev: Option<i64>) -> WeighingFacts {
        WeighingFacts {
            id: id.into(),
            carrier_id: "bin-23".into(),
            weighed_at: at,
            previous_weighed_at: prev,
            current: None,
            current_employee: None,
        }
    }

    #[test]
    fn single_verified_claim_in_cycle_credits_that_employee() {
        let d = decide(&weighing("w1", 10 * H, Some(8 * H)), &[claim("c1", "ruben", "bin-23", 9 * H)], 10 * H);
        assert_eq!(d.status, AssignmentStatus::Credited);
        assert_eq!(d.employee_id.as_deref(), Some("ruben"));
        assert_eq!(d.consume, vec!["c1"]);
    }

    #[test]
    fn claim_from_the_previous_cycle_does_not_count() {
        // Ruben scanned bin 23 before the previous weighing; that fill was already weighed.
        let d = decide(&weighing("w2", 10 * H, Some(8 * H)), &[claim("c1", "ruben", "bin-23", 7 * H)], 10 * H);
        assert_eq!(d.status, AssignmentStatus::Pending);
        // Exactly at the previous weighing belongs to the previous cycle.
        let d = decide(&weighing("w2", 10 * H, Some(8 * H)), &[claim("c1", "ruben", "bin-23", 8 * H)], 10 * H);
        assert_eq!(d.status, AssignmentStatus::Pending);
    }

    #[test]
    fn claim_after_the_weighing_does_not_count() {
        let d = decide(&weighing("w1", 10 * H, None), &[claim("c1", "ruben", "bin-23", 10 * H + 1)], 10 * H + 5 * M);
        assert_eq!(d.status, AssignmentStatus::Pending);
    }

    #[test]
    fn other_bins_claims_do_not_count() {
        let d = decide(&weighing("w1", 10 * H, None), &[claim("c1", "ruben", "bin-24", 9 * H)], 10 * H);
        assert_eq!(d.status, AssignmentStatus::Pending);
    }

    #[test]
    fn no_claim_is_pending_for_24_hours_then_expires_uncredited() {
        let w = weighing("w1", 10 * H, None);
        let d = decide(&w, &[], 10 * H);
        assert_eq!(d.status, AssignmentStatus::Pending);
        assert_eq!(d.pending_until, Some(34 * H));
        assert_eq!(decide(&w, &[], 34 * H - 1).status, AssignmentStatus::Pending);
        let d = decide(&w, &[], 34 * H);
        assert_eq!(d.status, AssignmentStatus::Expired);
        assert!(d.employee_id.is_none());
    }

    #[test]
    fn late_synced_claim_within_24_hours_recovers_the_pending_weighing() {
        let w = WeighingFacts {
            current: Some(AssignmentStatus::Pending),
            ..weighing("w1", 10 * H, Some(6 * H))
        };
        // Offline phone: event happened at 9:00, synced 20 hours later.
        let d = decide(&w, &[claim("c1", "maria", "bin-23", 9 * H)], 30 * H);
        assert_eq!(d.status, AssignmentStatus::Credited);
        assert_eq!(d.employee_id.as_deref(), Some("maria"));
    }

    #[test]
    fn expired_is_final_even_if_a_claim_arrives_later() {
        let w = WeighingFacts {
            current: Some(AssignmentStatus::Expired),
            ..weighing("w1", 10 * H, None)
        };
        let d = decide(&w, &[claim("c1", "maria", "bin-23", 9 * H)], 40 * H);
        assert_eq!(d.status, AssignmentStatus::Expired);
        assert!(d.employee_id.is_none());
    }

    #[test]
    fn two_employees_in_one_cycle_need_review_and_nobody_is_credited() {
        let claims = [claim("c1", "ruben", "bin-23", 9 * H), claim("c2", "maria", "bin-23", 9 * H + 30 * M)];
        let d = decide(&weighing("w1", 10 * H, Some(8 * H)), &claims, 10 * H);
        assert_eq!(d.status, AssignmentStatus::NeedsReview);
        assert!(d.employee_id.is_none() && d.consume.is_empty());
    }

    #[test]
    fn same_employee_scanning_twice_is_still_one_employee() {
        let claims = [claim("c1", "ruben", "bin-23", 9 * H), claim("c2", "ruben", "bin-23", 9 * H + 30 * M)];
        let d = decide(&weighing("w1", 10 * H, None), &claims, 10 * H);
        assert_eq!(d.status, AssignmentStatus::Credited);
        assert_eq!(d.consume, vec!["c1", "c2"]);
    }

    #[test]
    fn untrusted_phone_clock_never_credits() {
        let mut c = claim("c1", "ruben", "bin-23", 9 * H);
        c.clock_trusted = false;
        assert_eq!(decide(&weighing("w1", 10 * H, None), &[c], 10 * H).status, AssignmentStatus::Pending);
    }

    #[test]
    fn a_claim_consumed_by_another_weighing_cannot_credit_again() {
        let mut c = claim("c1", "ruben", "bin-23", 9 * H);
        c.consumed_by = Some("w0".into());
        assert_eq!(decide(&weighing("w1", 10 * H, None), &[c], 10 * H).status, AssignmentStatus::Pending);
    }

    fn credited(id: &str, at: i64, prev: Option<i64>, emp: &str) -> WeighingFacts {
        WeighingFacts {
            current: Some(AssignmentStatus::Credited),
            current_employee: Some(emp.into()),
            ..weighing(id, at, prev)
        }
    }

    #[test]
    fn a_credit_is_final_and_a_conflicting_late_claim_is_only_flagged() {
        let mut ruben = claim("c1", "ruben", "bin-23", 9 * H);
        ruben.consumed_by = Some("w1".into());
        let w = credited("w1", 10 * H, Some(8 * H), "ruben");
        // Maria's offline phone syncs a scan inside the same, already credited cycle.
        let maria = claim("c2", "maria", "bin-23", 8 * H + 30 * M);
        let d = decide(&w, &[ruben.clone(), maria], 12 * H);
        assert_eq!(d.status, AssignmentStatus::Credited);
        assert_eq!(d.employee_id.as_deref(), Some("ruben"));
        assert_eq!(d.conflicts, vec!["c2"]);
        assert!(d.consume.is_empty());
        // A further scan by the credited employee is absorbed, not a conflict.
        let again = claim("c3", "ruben", "bin-23", 9 * H + 10 * M);
        let d = decide(&w, &[ruben, again], 12 * H);
        assert_eq!((d.status, d.employee_id.as_deref()), (AssignmentStatus::Credited, Some("ruben")));
        assert_eq!(d.consume, vec!["c3"]);
        assert!(d.conflicts.is_empty());
    }

    #[test]
    fn a_credit_never_changes_even_without_its_claim() {
        // Defensive: whatever the claim table says, a credited weighing stays credited.
        let d = decide(&credited("w1", 10 * H, None, "ruben"), &[], 40 * H);
        assert_eq!((d.status, d.employee_id.as_deref()), (AssignmentStatus::Credited, Some("ruben")));
    }

    #[test]
    fn needs_review_is_final() {
        let w = WeighingFacts {
            current: Some(AssignmentStatus::NeedsReview),
            ..weighing("w1", 10 * H, None)
        };
        let d = decide(&w, &[claim("c1", "ruben", "bin-23", 9 * H)], 11 * H);
        assert_eq!(d.status, AssignmentStatus::NeedsReview);
        assert!(d.employee_id.is_none() && d.consume.is_empty());
    }

    #[test]
    fn a_scan_synced_20_hours_late_credits_only_the_cycle_it_happened_in() {
        // Bin 23 weighed at 8:00 (cycle 1) and 10:00 (cycle 2); the scan happened at 9:00.
        let c = [claim("c1", "maria", "bin-23", 9 * H)];
        let cycle1 = WeighingFacts {
            current: Some(AssignmentStatus::Pending),
            ..weighing("w1", 8 * H, None)
        };
        let cycle2 = WeighingFacts {
            current: Some(AssignmentStatus::Pending),
            ..weighing("w2", 10 * H, Some(8 * H))
        };
        assert_eq!(decide(&cycle1, &c, 29 * H).status, AssignmentStatus::Pending);
        let d = decide(&cycle2, &c, 29 * H);
        assert_eq!((d.status, d.employee_id.as_deref()), (AssignmentStatus::Credited, Some("maria")));
    }
}
