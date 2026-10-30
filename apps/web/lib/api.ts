import { createClient } from '@bsm/api-client';

export const api = createClient({ baseUrl: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1' });
