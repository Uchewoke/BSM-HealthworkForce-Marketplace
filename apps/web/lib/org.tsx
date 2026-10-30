'use client';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { orgRoleCan, type Permission } from '@bsm/permissions';
import { useClient } from '@bsm/ui';

export interface Org {
  id: string; name: string; type: string; status: string; role: string;
  legal_name: string | null; contact_email: string | null; contact_phone: string | null; website: string | null; state: string | null; created_at: string;
}
interface OrgValue { org: Org; reload: () => Promise<void>; can: (p: Permission) => boolean; approved: boolean }
const OrgContext = createContext<OrgValue | null>(null);

export function OrgProvider({ value, children }: { value: Omit<OrgValue, 'can' | 'approved'>; children: ReactNode }) {
  const full: OrgValue = { ...value, approved: value.org.status === 'approved', can: (p) => orgRoleCan(value.org.role, p) };
  return <OrgContext.Provider value={full}>{children}</OrgContext.Provider>;
}

export function useOrg(): OrgValue {
  const v = useContext(OrgContext);
  if (!v) throw new Error('useOrg must be used inside an organization page');
  return v;
}

export interface LocationOption { id: string; facilityId: string; label: string; state: string; timezone: string }

/** All active locations across the organization's facilities, flattened for dropdowns. */
export function useLocations(orgId: string) {
  const client = useClient();
  const [state, setState] = useState<{ locations: LocationOption[]; loading: boolean }>({ locations: [], loading: true });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { facilities } = await client.get<{ facilities: { id: string; name: string; active: boolean }[] }>(`/organizations/${orgId}/facilities`);
        const lists = await Promise.all(facilities.filter((f) => f.active).map(async (f) => {
          const { locations } = await client.get<{ locations: { id: string; name: string; state: string; timezone: string; active: boolean }[] }>(`/organizations/${orgId}/facilities/${f.id}/locations`);
          return locations.filter((l) => l.active).map((l) => ({ id: l.id, facilityId: f.id, state: l.state, timezone: l.timezone, label: `${f.name} — ${l.name} (${l.state})` }));
        }));
        if (!cancelled) setState({ locations: lists.flat(), loading: false });
      } catch { if (!cancelled) setState({ locations: [], loading: false }); }
    })();
    return () => { cancelled = true; };
  }, [client, orgId]);
  return state;
}
