-- ============================================================
-- Migration 025 — Company-scope previously-global catalogs
-- ============================================================
-- crops and contract_templates had no tenancy column at all
-- (not even site_id). Multi-company isolation requires one.
-- varieties and contract_profiles remain scoped transitively
-- through crop_id / contract_template_id — no column needed there.
-- ============================================================

BEGIN;

ALTER TABLE crops             ADD COLUMN company_id INTEGER REFERENCES companies (id);
ALTER TABLE contract_templates ADD COLUMN company_id INTEGER REFERENCES companies (id);

-- Backfill any existing rows onto the single pre-existing company.
-- No-op on a fresh database (both tables empty).
UPDATE crops
   SET company_id = (SELECT id FROM companies ORDER BY id LIMIT 1)
 WHERE company_id IS NULL;

UPDATE contract_templates
   SET company_id = (SELECT id FROM companies ORDER BY id LIMIT 1)
 WHERE company_id IS NULL;

ALTER TABLE crops             ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE contract_templates ALTER COLUMN company_id SET NOT NULL;

CREATE INDEX ON crops (company_id);
CREATE INDEX ON contract_templates (company_id);

COMMIT;
