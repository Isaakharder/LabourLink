//! SQLite store: carrier cache, the weighing outbox and assignment results.
//!
//! Durability: WAL + synchronous=FULL, so a weighing whose insert returned
//! survives a power cut. A weighing is written here BEFORE it is shown as
//! recorded or sent anywhere; the station-generated UUID is the idempotency
//! key the server deduplicates on, so resending after a crash is harmless.
//!
//! Isolation: each database is stamped with its mode on creation and refuses
//! to open in the other mode, and a trigger rejects simulated rows in a live
//! database (and real rows in a simulation database).

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::Path;

use crate::config::Mode;
use crate::machine::CarrierInfo;

const SCHEMA_VERSION: &str = "1";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Weighing {
    pub id: String,
    pub carrier_id: String,
    pub carrier_name: String,
    pub rfid_tag: String,
    pub gross_g: i64,
    pub tare_g: i64,
    pub net_g: i64,
    pub recorded_at: String,
    pub samples_g: Vec<i64>,
    pub simulated: bool,
    pub upload_state: String,
    pub upload_attempts: i64,
    pub last_error: Option<String>,
    pub assignment_status: String,
    pub employee_name: Option<String>,
    pub pending_until: Option<String>,
}

pub struct Store {
    conn: Connection,
    mode: Mode,
}

const SCHEMA: &str = r#"
create table if not exists meta (
  key   text primary key,
  value text not null
);

-- Cached copy of the server's carriers (bins) so weighing works offline.
create table if not exists carriers_cache (
  id         text primary key,
  name       text not null,
  rfid_tag   text unique,
  tare_g     integer not null,
  is_active  integer not null check (is_active in (0, 1)),
  synced_at  text not null
);

-- Outbox + history. One row per recorded weighing.
create table if not exists weighings (
  id                text primary key,       -- station UUID, server idempotency key
  carrier_id        text not null,
  carrier_name      text not null,
  rfid_tag          text not null,
  gross_g           integer not null,
  tare_g            integer not null,       -- tare copied at weighing time
  net_g             integer not null,
  recorded_at       text not null,          -- station clock, UTC RFC 3339
  samples_json      text not null,          -- stable-window readings (grams)
  simulated         integer not null check (simulated in (0, 1)),
  upload_state      text not null default 'queued'
                    check (upload_state in ('queued', 'sent', 'rejected')),
  upload_attempts   integer not null default 0,
  last_error        text,
  sent_at           text,
  assignment_status text not null default 'unknown'
                    check (assignment_status in ('unknown', 'credited', 'pending', 'needs_review', 'expired', 'voided')),
  employee_name     text,
  pending_until     text,
  status_checked_at text,
  check (net_g = gross_g - tare_g),
  check (tare_g > 0)
);

create index if not exists weighings_outbox on weighings (recorded_at) where upload_state = 'queued';
create index if not exists weighings_carrier_time on weighings (carrier_id, recorded_at);
create index if not exists weighings_pending on weighings (recorded_at) where assignment_status = 'pending';
"#;

fn row_to_weighing(r: &rusqlite::Row) -> rusqlite::Result<Weighing> {
    let samples: String = r.get("samples_json")?;
    Ok(Weighing {
        id: r.get("id")?,
        carrier_id: r.get("carrier_id")?,
        carrier_name: r.get("carrier_name")?,
        rfid_tag: r.get("rfid_tag")?,
        gross_g: r.get("gross_g")?,
        tare_g: r.get("tare_g")?,
        net_g: r.get("net_g")?,
        recorded_at: r.get("recorded_at")?,
        samples_g: serde_json::from_str(&samples).unwrap_or_default(),
        simulated: r.get::<_, i64>("simulated")? == 1,
        upload_state: r.get("upload_state")?,
        upload_attempts: r.get("upload_attempts")?,
        last_error: r.get("last_error")?,
        assignment_status: r.get("assignment_status")?,
        employee_name: r.get("employee_name")?,
        pending_until: r.get("pending_until")?,
    })
}

impl Store {
    pub fn open(path: &Path, mode: Mode) -> Result<Store, String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
        }
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        Self::init(conn, mode)
    }

    #[cfg(test)]
    pub fn open_in_memory(mode: Mode) -> Result<Store, String> {
        Self::init(Connection::open_in_memory().map_err(|e| e.to_string())?, mode)
    }

    fn init(conn: Connection, mode: Mode) -> Result<Store, String> {
        conn.pragma_update(None, "journal_mode", "WAL").map_err(|e| e.to_string())?;
        conn.pragma_update(None, "synchronous", "FULL").map_err(|e| e.to_string())?;
        conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(|e| e.to_string())?;
        conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;

        let existing: Option<String> = conn
            .query_row("select value from meta where key = 'mode'", [], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        match existing {
            Some(m) if m != mode.as_str() => {
                return Err(format!("database was created in {m} mode; refusing to open it in {} mode", mode.as_str()));
            }
            Some(_) => {}
            None => {
                conn.execute(
                    "insert into meta (key, value) values ('mode', ?1), ('schema_version', ?2)",
                    params![mode.as_str(), SCHEMA_VERSION],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        let forbidden = if mode.is_test() { 0 } else { 1 };
        conn.execute_batch(&format!(
            "create trigger if not exists weighings_mode_guard before insert on weighings
             when new.simulated = {forbidden}
             begin select raise(abort, 'weighing simulated flag does not match this database''s mode'); end;"
        ))
        .map_err(|e| e.to_string())?;
        Ok(Store { conn, mode })
    }

    pub fn replace_carriers(&mut self, carriers: &[CarrierInfo], synced_at: &str) -> Result<(), String> {
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        tx.execute("delete from carriers_cache", []).map_err(|e| e.to_string())?;
        for c in carriers {
            tx.execute(
                "insert into carriers_cache (id, name, rfid_tag, tare_g, is_active, synced_at) values (?1, ?2, ?3, ?4, ?5, ?6)",
                params![c.id, c.name, c.rfid_tag, c.tare_g, c.is_active as i64, synced_at],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.execute(
            "insert into meta (key, value) values ('carriers_synced_at', ?1) on conflict(key) do update set value = excluded.value",
            params![synced_at],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn carriers(&self) -> Result<Vec<CarrierInfo>, String> {
        let mut stmt = self
            .conn
            .prepare("select id, name, rfid_tag, tare_g, is_active from carriers_cache order by name")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(CarrierInfo {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    rfid_tag: r.get(2)?,
                    tare_g: r.get(3)?,
                    is_active: r.get::<_, i64>(4)? == 1,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn insert_weighing(&mut self, w: &Weighing) -> Result<(), String> {
        if w.simulated != self.mode.is_test() {
            return Err("weighing simulated flag does not match this database's mode".into());
        }
        self.conn
            .execute(
                "insert into weighings (id, carrier_id, carrier_name, rfid_tag, gross_g, tare_g, net_g, recorded_at, samples_json, simulated)
                 values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    w.id,
                    w.carrier_id,
                    w.carrier_name,
                    w.rfid_tag,
                    w.gross_g,
                    w.tare_g,
                    w.net_g,
                    w.recorded_at,
                    serde_json::to_string(&w.samples_g).unwrap(),
                    w.simulated as i64
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    #[cfg(test)]
    pub fn get(&self, id: &str) -> Result<Option<Weighing>, String> {
        self.conn
            .query_row("select * from weighings where id = ?1", params![id], row_to_weighing)
            .optional()
            .map_err(|e| e.to_string())
    }

    fn query(&self, sql: &str, p: impl rusqlite::Params) -> Result<Vec<Weighing>, String> {
        let mut stmt = self.conn.prepare(sql).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(p, row_to_weighing).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// Oldest first, so the server sees weighings in the order they happened.
    pub fn queued(&self, limit: i64) -> Result<Vec<Weighing>, String> {
        self.query(
            "select * from weighings where upload_state = 'queued' order by recorded_at, id limit ?1",
            params![limit],
        )
    }

    pub fn recent(&self, limit: i64) -> Result<Vec<Weighing>, String> {
        self.query("select * from weighings order by recorded_at desc, id desc limit ?1", params![limit])
    }

    /// Sent weighings whose server status the station must keep following:
    /// everything recorded since `since` (RFC 3339) except expired, which is
    /// final. Credited and under-review weighings are included so the station
    /// can never keep showing a credit the server no longer holds.
    pub fn to_verify(&self, since: &str) -> Result<Vec<Weighing>, String> {
        self.query(
            "select * from weighings where upload_state = 'sent' and assignment_status <> 'expired' and recorded_at >= ?1 order by recorded_at",
            params![since],
        )
    }

    /// Latest weighing per carrier recorded at or after `since` (RFC 3339),
    /// used to re-arm the duplicate guard after a restart.
    pub fn recent_by_carrier(&self, since: &str) -> Result<Vec<(String, String)>, String> {
        let mut stmt = self
            .conn
            .prepare("select carrier_id, max(recorded_at) from weighings where recorded_at >= ?1 group by carrier_id")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![since], |r| Ok((r.get(0)?, r.get(1)?))).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn mark_sent(&mut self, id: &str, at: &str, status: &str, employee: Option<&str>, pending_until: Option<&str>) -> Result<(), String> {
        self.conn
            .execute(
                "update weighings set upload_state = 'sent', sent_at = ?2, upload_attempts = upload_attempts + 1, last_error = null,
                   assignment_status = ?3, employee_name = ?4, pending_until = ?5, status_checked_at = ?2
                 where id = ?1",
                params![id, at, status, employee, pending_until],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn mark_attempt_failed(&mut self, id: &str, error: &str) -> Result<(), String> {
        self.conn
            .execute(
                "update weighings set upload_attempts = upload_attempts + 1, last_error = ?2 where id = ?1",
                params![id, error],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// The server permanently refused the weighing (4xx other than auth).
    /// Kept for the record; never retried automatically.
    pub fn mark_rejected(&mut self, id: &str, error: &str) -> Result<(), String> {
        self.conn
            .execute(
                "update weighings set upload_state = 'rejected', upload_attempts = upload_attempts + 1, last_error = ?2 where id = ?1",
                params![id, error],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// The server doesn't know this weighing (e.g. it was restored from a
    /// backup): send it again. Safe because the server dedupes on the UUID.
    pub fn requeue(&mut self, id: &str) -> Result<(), String> {
        self.conn
            .execute(
                "update weighings set upload_state = 'queued', assignment_status = 'unknown', employee_name = null, pending_until = null where id = ?1",
                params![id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn update_assignment(&mut self, id: &str, at: &str, status: &str, employee: Option<&str>, pending_until: Option<&str>) -> Result<(), String> {
        self.conn
            .execute(
                "update weighings set assignment_status = ?3, employee_name = ?4, pending_until = ?5, status_checked_at = ?2 where id = ?1",
                params![id, at, status, employee, pending_until],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn counts(&self) -> Result<(i64, i64, i64), String> {
        self.conn
            .query_row(
                "select
                   count(*) filter (where upload_state = 'queued'),
                   count(*) filter (where upload_state = 'sent' and assignment_status = 'pending'),
                   count(*) filter (where assignment_status = 'needs_review' or upload_state = 'rejected')
                 from weighings",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(id: &str, simulated: bool) -> Weighing {
        Weighing {
            id: id.into(),
            carrier_id: "c-a".into(),
            carrier_name: "Bin 23".into(),
            rfid_tag: "0000000182225750".into(),
            gross_g: 64_380,
            tare_g: 27_500,
            net_g: 36_880,
            recorded_at: format!("2026-10-27T10:00:0{}Z", id.len() % 10),
            samples_g: vec![64_380, 64_380],
            simulated,
            upload_state: "queued".into(),
            upload_attempts: 0,
            last_error: None,
            assignment_status: "unknown".into(),
            employee_name: None,
            pending_until: None,
        }
    }

    #[test]
    fn outbox_lifecycle() {
        let mut s = Store::open_in_memory(Mode::Simulation).unwrap();
        s.insert_weighing(&w("a", true)).unwrap();
        assert_eq!(s.queued(10).unwrap().len(), 1);
        assert!(s.insert_weighing(&w("a", true)).is_err(), "same UUID twice is rejected");
        s.mark_attempt_failed("a", "offline").unwrap();
        assert_eq!(s.queued(10).unwrap()[0].upload_attempts, 1);
        s.mark_sent("a", "2026-10-27T10:01:00Z", "pending", None, Some("2026-10-28T10:00:00Z")).unwrap();
        assert!(s.queued(10).unwrap().is_empty());
        let since = "2026-10-25T00:00:00Z";
        assert_eq!(s.to_verify(since).unwrap().len(), 1);
        assert_eq!(s.counts().unwrap(), (0, 1, 0));
        s.update_assignment("a", "2026-10-27T11:00:00Z", "credited", Some("Picker Alpha"), None)
            .unwrap();
        // Credited weighings keep being re-checked against the server...
        assert_eq!(s.to_verify(since).unwrap().len(), 1);
        assert_eq!(s.get("a").unwrap().unwrap().employee_name.as_deref(), Some("Picker Alpha"));
        // ...expired ones are final and aren't, and nothing older than the window is.
        assert!(s.to_verify("2026-10-28T00:00:00Z").unwrap().is_empty());
        s.update_assignment("a", "2026-10-28T11:00:00Z", "expired", None, None).unwrap();
        assert!(s.to_verify(since).unwrap().is_empty());
    }

    #[test]
    fn net_must_equal_gross_minus_tare_and_tare_must_be_positive() {
        let mut s = Store::open_in_memory(Mode::Simulation).unwrap();
        let mut bad = w("b", true);
        bad.net_g += 10;
        assert!(s.insert_weighing(&bad).is_err());
        let mut zero = w("z", true);
        zero.tare_g = 0;
        zero.net_g = zero.gross_g;
        assert!(s.insert_weighing(&zero).is_err());
    }

    #[test]
    fn simulated_rows_cannot_enter_a_live_database_even_bypassing_the_api() {
        let mut live = Store::open_in_memory(Mode::Live).unwrap();
        assert!(live.insert_weighing(&w("s", true)).is_err());
        // Direct SQL is stopped by the trigger as well.
        let err = live.conn.execute(
            "insert into weighings (id, carrier_id, carrier_name, rfid_tag, gross_g, tare_g, net_g, recorded_at, samples_json, simulated)
             values ('x', 'c', 'n', 't', 2, 1, 1, 'now', '[]', 1)",
            [],
        );
        assert!(err.is_err());
        live.insert_weighing(&w("r", false)).unwrap();
        let mut sim = Store::open_in_memory(Mode::Simulation).unwrap();
        assert!(sim.insert_weighing(&w("r", false)).is_err());
    }

    #[test]
    fn database_refuses_to_open_in_the_other_mode() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("scale.sqlite3");
        drop(Store::open(&path, Mode::Simulation).unwrap());
        let err = Store::open(&path, Mode::Live).err().unwrap();
        assert!(err.contains("simulation mode"), "{err}");
    }

    #[test]
    fn carriers_cache_round_trip_keeps_leading_zero_tags() {
        let mut s = Store::open_in_memory(Mode::Live).unwrap();
        let c = CarrierInfo {
            id: "c-a".into(),
            name: "Bin 23".into(),
            rfid_tag: Some("0000000182225750".into()),
            tare_g: 27_500,
            is_active: true,
        };
        s.replace_carriers(std::slice::from_ref(&c), "2026-10-27T10:00:00Z").unwrap();
        assert_eq!(s.carriers().unwrap(), vec![c]);
    }
}
