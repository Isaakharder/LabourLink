-- Optional RFID tag identifier on each carrier ("bin"), for the automated
-- weighing station: its PROTAGD reader (USB serial) reports a tag as a
-- 16-digit decimal string, e.g. "0000000182225750" from the line
-- "R 0000 0000000182225750". A later station flow will resolve that string
-- to a carrier to look up its tare_weight_kg; this migration only stores
-- the association.
--
-- Separate from nfc_tag_mappings (034_nfc_tag_mappings.sql) on purpose:
-- that table is the phone NFC workflow (Ridder / LabourLink tags read by the
-- mobile app) and is left untouched. A carrier's RFID tag is a plain
-- attribute of the carrier edited on Basic Data > Carriers, so a nullable
-- column is enough.
--
-- text, never numeric: leading zeros are part of the identifier. Stored in
-- the normalized form lib/rfidTag.ts's normalizeRfidTag() produces
-- (uppercase letters/digits, no whitespace), so equality and the unique
-- index below compare canonical values.
--
-- Additive only: every existing carrier gets null ("Not assigned"); no
-- existing column, row, NFC mapping or time entry is touched.
--
-- Single-tenant schema (see 043_mobile_time_events.sql): no organization
-- column, so "unique within the organization" is unique across this table.
alter table carriers
  add column rfid_tag text
    constraint chk_carriers_rfid_tag_format check (rfid_tag ~ '^[0-9A-Z]{1,64}$');

-- At most one carrier per tag. Deliberately includes inactive carriers: a
-- deactivated bin keeps its tag until an admin clears it, so a tag can never
-- silently resolve to two carriers.
create unique index carriers_rfid_tag_key
  on carriers (rfid_tag)
  where rfid_tag is not null;
