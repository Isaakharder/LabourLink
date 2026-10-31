//! Employee assignment rule for a weighing — the station's copy.
//!
//! The station never decides who gets credit. The LabourLink server does,
//! from evidence only it has (phone bin choices synced through
//! `mobile_time_events`), in server/src/lib/scaleMatchingRule.ts. This module
//! is the same rule for the in-process test server (simulation and hardware
//! test). Both implementations run the shared cases in
//! `matching.vectors.json` (a copy of server/src/lib/scaleMatching.vectors.json),
//! so they can't drift apart.
//!
//! A bin-use cycle for carrier X weighed at T is the half-open interval
//! (previous weighing of X, T]. A bin's first weighing has no previous one;
//! its cycle starts FIRST_CYCLE_LOOKBACK_MS before it. Every weighing closes
//! a cycle whatever its outcome, so consecutive uses of the same bin are
//! independent. A *claim* is a phone event in which an employee chose bin X
//! (NFC scan or picked by hand). It counts only if it happened inside the
//! cycle, its phone clock wasn't flagged, the server received it no later
//! than 24 hours after the weighing, and no other weighing has used it.
//!
//! * exactly one employee → **credited**; their claims are consumed (one
//!   claim can never credit two weighings);
//! * two or more → **needs review**, nobody credited;
//! * none yet → **pending**;
//! * none 24 hours after the weighing → **expired**, never credited.
//!
//! Credited, needs review, expired and voided are final. A later claim from
//! a *different* employee inside a credited cycle is reported in
//! `Decision::conflicts` for review; the credit is unchanged.

use serde::Serialize;

pub const PENDING_RECOVERY_MS: i64 = 24 * 60 * 60 * 1000;
pub const FIRST_CYCLE_LOOKBACK_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AssignmentStatus {
    Credited,
    Pending,
    NeedsReview,
    Expired,
    /// Set only by an administrator on the server; the test server never voids.
    #[cfg_attr(not(test), allow(dead_code))]
    Voided,
}

impl AssignmentStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            AssignmentStatus::Credited => "credited",
            AssignmentStatus::Pending => "pending",
            AssignmentStatus::NeedsReview => "needs_review",
            AssignmentStatus::Expired => "expired",
            AssignmentStatus::Voided => "voided",
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
    /// When the server received it, ms since epoch.
    pub received_at: i64,
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
    /// Claims of two or more employees in one cycle (needs review).
    pub competing: Vec<String>,
    /// Claims from other employees inside this already credited cycle. They
    /// change nothing; the server flags them for supervisor review.
    pub conflicts: Vec<String>,
    pub pending_until: i64,
}

pub fn cycle_start(w: &WeighingFacts) -> i64 {
    w.previous_weighed_at.unwrap_or(w.weighed_at - FIRST_CYCLE_LOOKBACK_MS)
}

pub fn decide(w: &WeighingFacts, claims: &[Claim], now: i64) -> Decision {
    let pending_until = w.weighed_at + PENDING_RECOVERY_MS;
    let start = cycle_start(w);
    let eligible: Vec<&Claim> = claims
        .iter()
        .filter(|c| c.carrier_id == w.carrier_id && c.occurred_at > start && c.occurred_at <= w.weighed_at)
        .filter(|c| c.clock_trusted && c.received_at <= pending_until)
        .filter(|c| c.consumed_by.is_none() || c.consumed_by.as_deref() == Some(w.id.as_str()))
        .collect();
    let unchanged = |status, employee_id: Option<String>| Decision {
        status,
        employee_id,
        consume: vec![],
        competing: vec![],
        conflicts: vec![],
        pending_until,
    };

    match w.current {
        // Final: a credit never changes. Further choices of the bin by the
        // credited employee in this cycle are absorbed; anyone else's are
        // reported as conflicts for review.
        Some(AssignmentStatus::Credited) => {
            let credited = w.current_employee.as_deref();
            let (same, other): (Vec<&Claim>, Vec<&Claim>) = eligible.into_iter().partition(|c| Some(c.employee_id.as_str()) == credited);
            return Decision {
                consume: same.iter().filter(|c| c.consumed_by.is_none()).map(|c| c.id.clone()).collect(),
                conflicts: other.iter().map(|c| c.id.clone()).collect(),
                ..unchanged(AssignmentStatus::Credited, w.current_employee.clone())
            };
        }
        Some(s @ (AssignmentStatus::Expired | AssignmentStatus::NeedsReview | AssignmentStatus::Voided)) => {
            return unchanged(s, w.current_employee.clone());
        }
        _ => {}
    }

    let mut employees: Vec<&str> = eligible.iter().map(|c| c.employee_id.as_str()).collect();
    employees.sort();
    employees.dedup();

    match employees.len() {
        1 => Decision {
            consume: eligible.iter().map(|c| c.id.clone()).collect(),
            ..unchanged(AssignmentStatus::Credited, Some(employees[0].to_string()))
        },
        0 if now >= pending_until => unchanged(AssignmentStatus::Expired, None),
        0 => unchanged(AssignmentStatus::Pending, None),
        _ => Decision {
            competing: eligible.iter().map(|c| c.id.clone()).collect(),
            ..unchanged(AssignmentStatus::NeedsReview, None)
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    const MIN: i64 = 60_000;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct VClaim {
        id: String,
        employee: String,
        at: i64,
        received_at: Option<i64>,
        clock_trusted: Option<bool>,
        consumed_by: Option<String>,
    }

    #[derive(Deserialize)]
    struct VWeighing {
        id: String,
        at: i64,
        previous: Option<i64>,
        current: String,
        employee: Option<String>,
    }

    #[derive(Deserialize)]
    struct VExpect {
        status: String,
        employee: Option<String>,
        #[serde(default)]
        consume: Vec<String>,
        #[serde(default)]
        competing: Vec<String>,
        #[serde(default)]
        conflicts: Vec<String>,
    }

    #[derive(Deserialize)]
    struct Vector {
        name: String,
        weighing: VWeighing,
        claims: Vec<VClaim>,
        now: i64,
        expect: VExpect,
    }

    #[derive(Deserialize)]
    struct Vectors {
        cases: Vec<Vector>,
    }

    fn status(s: &str) -> AssignmentStatus {
        match s {
            "credited" => AssignmentStatus::Credited,
            "pending" => AssignmentStatus::Pending,
            "needs_review" => AssignmentStatus::NeedsReview,
            "expired" => AssignmentStatus::Expired,
            "voided" => AssignmentStatus::Voided,
            other => panic!("unknown status {other}"),
        }
    }

    /// The same cases the server's scaleMatchingRule.test.ts runs.
    #[test]
    fn shared_vectors_match_the_server_rule() {
        let v: Vectors = serde_json::from_str(include_str!("matching.vectors.json")).unwrap();
        assert!(v.cases.len() >= 20);
        for c in v.cases {
            let claims: Vec<Claim> = c
                .claims
                .iter()
                .map(|x| Claim {
                    id: x.id.clone(),
                    employee_id: x.employee.clone(),
                    carrier_id: "bin".into(),
                    occurred_at: x.at * MIN,
                    received_at: x.received_at.unwrap_or(x.at) * MIN,
                    clock_trusted: x.clock_trusted.unwrap_or(true),
                    consumed_by: x.consumed_by.clone(),
                })
                .collect();
            let w = WeighingFacts {
                id: c.weighing.id.clone(),
                carrier_id: "bin".into(),
                weighed_at: c.weighing.at * MIN,
                previous_weighed_at: c.weighing.previous.map(|p| p * MIN),
                current: Some(status(&c.weighing.current)),
                current_employee: c.weighing.employee.clone(),
            };
            let d = decide(&w, &claims, c.now * MIN);
            assert_eq!(d.status, status(&c.expect.status), "{}", c.name);
            assert_eq!(d.employee_id, c.expect.employee, "{}", c.name);
            assert_eq!(d.consume, c.expect.consume, "{}", c.name);
            assert_eq!(d.competing, c.expect.competing, "{}", c.name);
            assert_eq!(d.conflicts, c.expect.conflicts, "{}", c.name);
            assert_eq!(d.pending_until, (c.weighing.at + 24 * 60) * MIN, "{}", c.name);
        }
    }

    #[test]
    fn the_station_copy_of_the_vectors_is_the_servers() {
        // Both copies must stay byte-identical; the server's lives in
        // server/src/lib/scaleMatching.vectors.json. If this repository
        // checkout also has the server, compare them.
        let here = include_str!("matching.vectors.json");
        let server = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../server/src/lib/scaleMatching.vectors.json");
        if let Ok(theirs) = std::fs::read_to_string(&server) {
            assert_eq!(here.replace("\r\n", "\n"), theirs.replace("\r\n", "\n"), "matching.vectors.json differs from the server's copy");
        }
    }

    fn claim(id: &str, emp: &str, at: i64) -> Claim {
        Claim {
            id: id.into(),
            employee_id: emp.into(),
            carrier_id: "bin-23".into(),
            occurred_at: at,
            received_at: at,
            clock_trusted: true,
            consumed_by: None,
        }
    }

    #[test]
    fn claims_for_another_bin_never_count() {
        let w = WeighingFacts {
            id: "w1".into(),
            carrier_id: "bin-24".into(),
            weighed_at: 600 * MIN,
            previous_weighed_at: None,
            current: None,
            current_employee: None,
        };
        assert_eq!(decide(&w, &[claim("c1", "ruben", 540 * MIN)], 600 * MIN).status, AssignmentStatus::Pending);
    }
}
