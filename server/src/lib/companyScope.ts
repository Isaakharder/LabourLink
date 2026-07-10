import { db } from '../db';

// Ownership-check helpers used to gate nested/detail routes. Each confirms
// that a given resource id actually belongs to the caller's company before
// the route handler is allowed to touch it — company_id/site_id chains are
// resolved server-side only, never trusted from the request.

export async function siteBelongsToCompany(siteId: number, companyId: number): Promise<boolean> {
  const { rows } = await db.query('SELECT 1 FROM sites WHERE id = $1 AND company_id = $2', [siteId, companyId]);
  return rows.length > 0;
}

export async function locationBelongsToCompany(locationId: number, companyId: number): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM locations l JOIN sites s ON s.id = l.site_id WHERE l.id = $1 AND s.company_id = $2`,
    [locationId, companyId],
  );
  return rows.length > 0;
}

export async function locationGroupBelongsToCompany(groupId: number, companyId: number): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM location_groups lg JOIN sites s ON s.id = lg.site_id WHERE lg.id = $1 AND s.company_id = $2`,
    [groupId, companyId],
  );
  return rows.length > 0;
}

export async function greenhouseMapBelongsToCompany(mapId: number, companyId: number): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM greenhouse_maps gm JOIN sites s ON s.id = gm.site_id WHERE gm.id = $1 AND s.company_id = $2`,
    [mapId, companyId],
  );
  return rows.length > 0;
}

export async function compartmentBelongsToMap(compartmentId: number, mapId: number): Promise<boolean> {
  const { rows } = await db.query(
    'SELECT 1 FROM greenhouse_compartments WHERE id = $1 AND map_id = $2',
    [compartmentId, mapId],
  );
  return rows.length > 0;
}

export async function blockBelongsToCompartment(blockId: number, compartmentId: number): Promise<boolean> {
  const { rows } = await db.query(
    'SELECT 1 FROM greenhouse_row_blocks WHERE id = $1 AND compartment_id = $2',
    [blockId, compartmentId],
  );
  return rows.length > 0;
}

export async function walkwayBelongsToCompartment(walkwayId: number, compartmentId: number): Promise<boolean> {
  const { rows } = await db.query(
    'SELECT 1 FROM greenhouse_walkways WHERE id = $1 AND compartment_id = $2',
    [walkwayId, compartmentId],
  );
  return rows.length > 0;
}

export async function rowBelongsToCompartment(rowId: number, compartmentId: number): Promise<boolean> {
  const { rows } = await db.query(
    'SELECT 1 FROM greenhouse_rows WHERE id = $1 AND compartment_id = $2',
    [rowId, compartmentId],
  );
  return rows.length > 0;
}

export async function cropBelongsToCompany(cropId: number, companyId: number): Promise<boolean> {
  const { rows } = await db.query('SELECT 1 FROM crops WHERE id = $1 AND company_id = $2', [cropId, companyId]);
  return rows.length > 0;
}

export async function varietyBelongsToCompany(varietyId: number, companyId: number): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM varieties v JOIN crops c ON c.id = v.crop_id WHERE v.id = $1 AND c.company_id = $2`,
    [varietyId, companyId],
  );
  return rows.length > 0;
}

export async function contractTemplateBelongsToCompany(templateId: number, companyId: number): Promise<boolean> {
  const { rows } = await db.query(
    'SELECT 1 FROM contract_templates WHERE id = $1 AND company_id = $2',
    [templateId, companyId],
  );
  return rows.length > 0;
}

export async function contractProfileBelongsToCompany(profileId: number, companyId: number): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM contract_profiles cp
     JOIN contract_templates ct ON ct.id = cp.contract_template_id
     WHERE cp.id = $1 AND ct.company_id = $2`,
    [profileId, companyId],
  );
  return rows.length > 0;
}

// Returns the subset of rowIds that actually belong to a greenhouse row
// under this company. Used to validate crop-location / plant-density links.
export async function filterRowIdsByCompany(rowIds: number[], companyId: number): Promise<number[]> {
  if (!rowIds.length) return [];
  const { rows } = await db.query(
    `SELECT gr.id FROM greenhouse_rows gr
     JOIN greenhouse_row_blocks gb ON gb.id = gr.block_id
     JOIN greenhouse_compartments gc ON gc.id = gb.compartment_id
     JOIN greenhouse_maps gm ON gm.id = gc.map_id
     JOIN sites s ON s.id = gm.site_id
     WHERE gr.id = ANY($1::int[]) AND s.company_id = $2`,
    [rowIds, companyId],
  );
  return rows.map((r) => r.id as number);
}

export async function employeeBelongsToCompany(employeeId: number, companyId: number): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM employment_records er
     JOIN sites s ON s.id = er.site_id
     WHERE er.employee_id = $1 AND s.company_id = $2
     LIMIT 1`,
    [employeeId, companyId],
  );
  return rows.length > 0;
}
