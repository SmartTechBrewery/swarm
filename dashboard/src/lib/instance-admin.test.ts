import { describe, expect, it } from 'vitest';
import { canViewInstanceWide, landingRouteFor } from './instance-admin.js';

describe('canViewInstanceWide (issue #647)', () => {
	it('admits an instance administrator', () => {
		expect(canViewInstanceWide({ instanceAdmin: true })).toBe(true);
	});

	it('denies an ordinary user — a worker owner reads runs/workers per project', () => {
		expect(canViewInstanceWide({ instanceAdmin: false })).toBe(false);
	});

	it('denies an unresolved session rather than assuming either way', () => {
		expect(canViewInstanceWide(undefined)).toBe(false);
		expect(canViewInstanceWide(null)).toBe(false);
	});
});

describe('landingRouteFor (issue #647)', () => {
	it('sends an administrator to the installation-wide runs view', () => {
		expect(landingRouteFor({ instanceAdmin: true })).toBe('/runs');
	});

	it('sends anyone else to their projects, not to a page they would be denied', () => {
		expect(landingRouteFor({ instanceAdmin: false })).toBe('/projects');
		expect(landingRouteFor(undefined)).toBe('/projects');
	});
});
