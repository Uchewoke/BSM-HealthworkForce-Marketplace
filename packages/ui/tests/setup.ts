import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { toHaveNoViolations } from 'jest-axe';
import { afterEach, expect, vi } from 'vitest';

expect.extend(toHaveNoViolations);
afterEach(() => cleanup());

// Components use next/link and next/navigation; outside Next they only need a harmless stand-in.
vi.mock('next/navigation', () => ({ usePathname: () => '/professional/credentials', useRouter: () => ({ push: vi.fn() }), useParams: () => ({}) }));
