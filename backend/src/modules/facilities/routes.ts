import { Router, type Request } from 'express';
import { z } from 'zod';
import { requireApprovedOrg, requireOrgPermission } from '../../middleware/access.js';
import { param, validate } from '../../middleware/http.js';
import type { AppDeps } from '../../shared/deps.js';
import { AppError } from '../../shared/errors.js';
import { updateRow } from '../../shared/sql.js';
import { audit } from '../audit/service.js';

const name = z.string().trim().min(2).max(160);
const timezone = z.string().refine((tz) => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}, 'Unknown IANA time zone');

const facilityBody = z.object({
  name,
  facilityType: z.enum(['hospital', 'clinic', 'long_term_care', 'rehabilitation', 'home_health', 'other']),
});
const locationBody = z.object({
  name,
  addressLine1: z.string().trim().min(3).max(200),
  addressLine2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(2).max(100),
  state: z.string().trim().length(2).transform((s) => s.toUpperCase()).pipe(z.string().regex(/^[A-Z]{2}$/)),
  postalCode: z.string().trim().regex(/^\d{5}(-\d{4})?$/, 'Use a US ZIP code'),
  timezone,
  phone: z.string().trim().regex(/^\+?[0-9 ()\-.]{7,20}$/).optional(),
});
const departmentBody = z.object({ name });

const patch = <T extends z.ZodObject>(s: T) =>
  s.partial().extend({ active: z.boolean().optional() }).refine((b) => Object.keys(b).length > 0, 'Provide at least one field.');

const FACILITY_COLS = { name: 'name', facilityType: 'facility_type', active: 'active' };
const LOCATION_COLS = {
  name: 'name', addressLine1: 'address_line1', addressLine2: 'address_line2', city: 'city', state: 'state',
  postalCode: 'postal_code', timezone: 'timezone', phone: 'phone', active: 'active',
};
const DEPT_COLS = { name: 'name', active: 'active' };

const FACILITY_RET = 'id, name, facility_type, active, created_at';
const LOCATION_RET = 'id, facility_id, name, address_line1, address_line2, city, state, postal_code, timezone, phone, active, created_at';
const DEPT_RET = 'id, location_id, name, active, created_at';

const P = {
  org: z.object({ orgId: z.uuid() }),
  facility: z.object({ orgId: z.uuid(), facilityId: z.uuid() }),
  location: z.object({ orgId: z.uuid(), facilityId: z.uuid(), locationId: z.uuid() }),
  dept: z.object({ orgId: z.uuid(), facilityId: z.uuid(), locationId: z.uuid(), departmentId: z.uuid() }),
};

/**
 * Mounted at /organizations/:orgId/facilities. Reads need locations.read; writes need locations.manage AND an approved
 * organization. Every query is scoped by organization_id AND the parent id, so substituting another tenant's ids yields 404.
 */
export function facilityRoutes(deps: AppDeps) {
  const { db } = deps;
  const r = Router({ mergeParams: true });
  const read = requireOrgPermission(deps, 'locations.read');
  const write = [requireOrgPermission(deps, 'locations.manage'), requireApprovedOrg(deps)];
  const notFound = () => new AppError('NOT_FOUND', 'Resource not found.');

  const facilityExists = async (orgId: string, facilityId: string) => {
    if (!(await db.query('SELECT 1 FROM facilities WHERE id = $1 AND organization_id = $2', [facilityId, orgId]))[0]) throw notFound();
  };
  const locationExists = async (orgId: string, facilityId: string, locationId: string) => {
    if (!(await db.query('SELECT 1 FROM facility_locations WHERE id = $1 AND facility_id = $2 AND organization_id = $3', [locationId, facilityId, orgId]))[0]) throw notFound();
  };
  const log = (req: Request, action: string, type: string, id: string) =>
    audit(db, { actorUserId: req.auth!.userId, action, targetType: type, targetId: id, organizationId: req.membership!.organizationId, requestId: req.requestId });

  // ---- facilities
  r.get('/', validate({ params: P.org }), read, async (req, res) => {
    res.json({ facilities: await db.query(`SELECT ${FACILITY_RET} FROM facilities WHERE organization_id = $1 ORDER BY name`, [req.membership!.organizationId]) });
  });
  r.post('/', validate({ params: P.org, body: facilityBody }), ...write, async (req, res) => {
    const [row] = await db.query(
      `INSERT INTO facilities (organization_id, name, facility_type) VALUES ($1,$2,$3) RETURNING ${FACILITY_RET}`,
      [req.membership!.organizationId, req.body.name, req.body.facilityType]);
    await log(req, 'facility.created', 'facility', (row as any).id);
    res.status(201).json({ facility: row });
  });
  r.patch('/:facilityId', validate({ params: P.facility, body: patch(facilityBody) }), ...write, async (req, res) => {
    const orgId = req.membership!.organizationId;
    const row = await updateRow(db, 'facilities', FACILITY_COLS, req.body, { id: param(req, 'facilityId'), organizationId: orgId }, FACILITY_RET);
    if (!row) throw notFound();
    await log(req, 'facility.updated', 'facility', param(req, 'facilityId'));
    res.json({ facility: row });
  });

  // ---- locations
  r.get('/:facilityId/locations', validate({ params: P.facility }), read, async (req, res) => {
    const orgId = req.membership!.organizationId;
    await facilityExists(orgId, param(req, 'facilityId'));
    res.json({ locations: await db.query(`SELECT ${LOCATION_RET} FROM facility_locations WHERE facility_id = $1 AND organization_id = $2 ORDER BY name`, [param(req, 'facilityId'), orgId]) });
  });
  r.post('/:facilityId/locations', validate({ params: P.facility, body: locationBody }), ...write, async (req, res) => {
    const orgId = req.membership!.organizationId;
    await facilityExists(orgId, param(req, 'facilityId'));
    const b = req.body;
    const [row] = await db.query(
      `INSERT INTO facility_locations (organization_id, facility_id, name, address_line1, address_line2, city, state, postal_code, timezone, phone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${LOCATION_RET}`,
      [orgId, param(req, 'facilityId'), b.name, b.addressLine1, b.addressLine2 ?? null, b.city, b.state, b.postalCode, b.timezone, b.phone ?? null]);
    await log(req, 'location.created', 'facility_location', (row as any).id);
    res.status(201).json({ location: row });
  });
  r.patch('/:facilityId/locations/:locationId', validate({ params: P.location, body: patch(locationBody) }), ...write, async (req, res) => {
    const orgId = req.membership!.organizationId;
    await locationExists(orgId, param(req, 'facilityId'), param(req, 'locationId'));
    const row = await updateRow(db, 'facility_locations', LOCATION_COLS, req.body, { id: param(req, 'locationId'), organizationId: orgId }, LOCATION_RET);
    if (!row) throw notFound();
    await log(req, 'location.updated', 'facility_location', param(req, 'locationId'));
    res.json({ location: row });
  });

  // ---- departments
  r.get('/:facilityId/locations/:locationId/departments', validate({ params: P.location }), read, async (req, res) => {
    const orgId = req.membership!.organizationId;
    await locationExists(orgId, param(req, 'facilityId'), param(req, 'locationId'));
    res.json({ departments: await db.query(`SELECT ${DEPT_RET} FROM departments WHERE location_id = $1 AND organization_id = $2 ORDER BY name`, [param(req, 'locationId'), orgId]) });
  });
  r.post('/:facilityId/locations/:locationId/departments', validate({ params: P.location, body: departmentBody }), ...write, async (req, res) => {
    const orgId = req.membership!.organizationId;
    await locationExists(orgId, param(req, 'facilityId'), param(req, 'locationId'));
    const [row] = await db.query(
      `INSERT INTO departments (organization_id, location_id, name) VALUES ($1,$2,$3) RETURNING ${DEPT_RET}`,
      [orgId, param(req, 'locationId'), req.body.name]);
    await log(req, 'department.created', 'department', (row as any).id);
    res.status(201).json({ department: row });
  });
  r.patch('/:facilityId/locations/:locationId/departments/:departmentId', validate({ params: P.dept, body: patch(departmentBody) }), ...write, async (req, res) => {
    const orgId = req.membership!.organizationId;
    await locationExists(orgId, param(req, 'facilityId'), param(req, 'locationId'));
    const set = await db.query('SELECT 1 FROM departments WHERE id = $1 AND location_id = $2 AND organization_id = $3', [param(req, 'departmentId'), param(req, 'locationId'), orgId]);
    if (!set[0]) throw notFound();
    const row = await updateRow(db, 'departments', DEPT_COLS, req.body, { id: param(req, 'departmentId'), organizationId: orgId }, DEPT_RET);
    await log(req, 'department.updated', 'department', param(req, 'departmentId'));
    res.json({ department: row });
  });

  return r;
}
