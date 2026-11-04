export const FACILITY_ROLES = [
  'facility_owner', 'facility_admin', 'hiring_manager', 'recruiter', 'scheduler', 'finance', 'read_only',
] as const;
export const AGENCY_ROLES = [
  'agency_owner', 'agency_admin', 'agency_recruiter', 'agency_finance', 'agency_read_only',
] as const;
export const PLATFORM_ROLES = [
  'platform_super_admin', 'platform_admin', 'verification_reviewer', 'support_agent', 'finance_admin', 'auditor',
] as const;

export type FacilityRole = (typeof FACILITY_ROLES)[number];
export type AgencyRole = (typeof AGENCY_ROLES)[number];
export type PlatformRole = (typeof PLATFORM_ROLES)[number];
export type OrgRole = FacilityRole | AgencyRole;

export const PERMISSIONS = [
  'org.read', 'org.update', 'org.submit_for_review',
  'members.read', 'members.invite', 'members.manage',
  'locations.read', 'locations.manage',
  'jobs.read', 'jobs.manage', 'jobs.publish',
  'applications.read', 'applications.manage',
  'professionals.search',
  'billing.read', 'billing.manage',
  'agency.roster.read', 'agency.roster.manage', 'agency.jobs.read', 'agency.submissions.read', 'agency.submissions.manage',
  'admin.facility_review', 'admin.credential_review', 'admin.user_lookup',
  'admin.audit_read', 'admin.taxonomy_manage', 'admin.settings_manage', 'admin.support',
  'admin.marketplace_oversight', 'admin.user_manage', 'admin.billing_manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const readOnly: Permission[] = ['org.read', 'members.read', 'locations.read', 'jobs.read', 'applications.read'];
const manager: Permission[] = [
  ...readOnly, 'jobs.manage', 'jobs.publish', 'applications.manage', 'professionals.search',
];
const admin: Permission[] = [...manager, 'org.update', 'org.submit_for_review', 'members.invite', 'members.manage', 'locations.manage'];

const agencyRead: Permission[] = ['org.read', 'members.read', 'agency.roster.read', 'agency.jobs.read', 'agency.submissions.read'];
const agencyRecruiter: Permission[] = [...agencyRead, 'agency.roster.manage', 'agency.submissions.manage'];
const agencyAdmin: Permission[] = [...agencyRecruiter, 'org.update', 'org.submit_for_review', 'members.invite', 'members.manage'];

/** Organization-scoped permissions. Least privilege: absent role/permission means denied. */
export const ORG_ROLE_PERMISSIONS: Record<OrgRole, readonly Permission[]> = {
  facility_owner: [...admin, 'billing.read', 'billing.manage'],
  facility_admin: admin,
  hiring_manager: manager,
  recruiter: [...readOnly, 'applications.manage', 'professionals.search'],
  scheduler: [...readOnly, 'jobs.manage'],
  finance: [...readOnly, 'billing.read'],
  read_only: readOnly,
  // Agency roles carry no facility permissions (jobs, locations, applications): agencies only see what a facility grants them.
  agency_owner: [...agencyAdmin, 'billing.read', 'billing.manage'], agency_admin: agencyAdmin, agency_recruiter: agencyRecruiter,
  agency_finance: [...agencyRead, 'billing.read'], agency_read_only: agencyRead,
};

/** Platform permissions are explicit and never implied by organization roles. */
export const PLATFORM_ROLE_PERMISSIONS: Record<PlatformRole, readonly Permission[]> = {
  platform_super_admin: [
    'admin.facility_review', 'admin.credential_review', 'admin.user_lookup', 'admin.audit_read',
    'admin.taxonomy_manage', 'admin.settings_manage', 'admin.support', 'admin.marketplace_oversight', 'admin.user_manage', 'admin.billing_manage',
  ],
  platform_admin: ['admin.facility_review', 'admin.user_lookup', 'admin.taxonomy_manage', 'admin.support', 'admin.marketplace_oversight', 'admin.user_manage'],
  verification_reviewer: ['admin.facility_review', 'admin.credential_review'],
  support_agent: ['admin.user_lookup', 'admin.support'],
  finance_admin: ['admin.user_lookup', 'admin.billing_manage'],
  auditor: ['admin.audit_read'],
};

/** Platform roles that must have MFA before any admin action. */
export const MFA_REQUIRED_PLATFORM_ROLES: readonly PlatformRole[] = [...PLATFORM_ROLES];

export function orgRoleCan(role: string, permission: Permission): boolean {
  const perms = (ORG_ROLE_PERMISSIONS as Record<string, readonly Permission[] | undefined>)[role];
  return perms?.includes(permission) ?? false;
}

/**
 * Privilege-escalation guard: a member may only grant or alter roles whose permissions are a subset of
 * their own, and ownership is never grantable this way.
 */
export function canGrantRole(granterRole: string, targetRole: string): boolean {
  if (targetRole === 'facility_owner' || targetRole === 'agency_owner') return false;
  const map = ORG_ROLE_PERMISSIONS as Record<string, readonly Permission[] | undefined>;
  const granter = map[granterRole];
  const target = map[targetRole];
  if (!granter || !target) return false;
  return target.every((p) => granter.includes(p));
}

export function platformRoleCan(role: string, permission: Permission): boolean {
  const perms = (PLATFORM_ROLE_PERMISSIONS as Record<string, readonly Permission[] | undefined>)[role];
  return perms?.includes(permission) ?? false;
}
