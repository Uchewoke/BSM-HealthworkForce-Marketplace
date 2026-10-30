import { describe, expect, it } from 'vitest';
import { canGrantRole, orgRoleCan, platformRoleCan, PLATFORM_ROLES } from './index.js';

describe('permissions', () => {
  it('denies unknown roles and permissions by default', () => {
    expect(orgRoleCan('nonsense', 'org.read')).toBe(false);
    expect(orgRoleCan('read_only', 'jobs.manage')).toBe(false);
  });
  it('read_only cannot mutate anything', () => {
    for (const p of ['org.update', 'members.invite', 'jobs.publish', 'applications.manage'] as const) {
      expect(orgRoleCan('read_only', p)).toBe(false);
    }
  });
  it('organization roles never grant platform admin permissions', () => {
    expect(orgRoleCan('facility_owner', 'admin.facility_review')).toBe(false);
  });
  it('only credential reviewers and super admins can review credentials', () => {
    const allowed = PLATFORM_ROLES.filter((r) => platformRoleCan(r, 'admin.credential_review'));
    expect(allowed.sort()).toEqual(['platform_super_admin', 'verification_reviewer']);
  });
  it('role grants cannot escalate privileges', () => {
    expect(canGrantRole('facility_admin', 'facility_owner')).toBe(false);
    expect(canGrantRole('facility_owner', 'facility_owner')).toBe(false);
    expect(canGrantRole('facility_owner', 'finance')).toBe(true);
    expect(canGrantRole('facility_admin', 'finance')).toBe(false); // finance has billing.read, admin does not
    expect(canGrantRole('hiring_manager', 'facility_admin')).toBe(false);
    expect(canGrantRole('read_only', 'read_only')).toBe(true);
    expect(canGrantRole('read_only', 'scheduler')).toBe(false);
    expect(canGrantRole('nonsense', 'read_only')).toBe(false);
  });
  it('support agents cannot read audit logs', () => {
    expect(platformRoleCan('support_agent', 'admin.audit_read')).toBe(false);
  });
});
