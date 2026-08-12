import { describe, expect, it } from 'vitest';

import {
	installationRoleFor,
	isInstanceAdmin,
	SwarmUserSchema,
	UserDisplayNameSchema,
} from '@/identity/schema.js';

const validUser = {
	id: '11111111-1111-4111-8111-111111111111',
	identifier: 'ada@example.com',
	displayName: 'Ada Lovelace',
	instanceAdmin: false,
	createdAt: new Date('2026-01-01T00:00:00Z'),
	updatedAt: new Date('2026-01-01T00:00:00Z'),
};

describe('SwarmUserSchema', () => {
	it('accepts a valid user', () => {
		expect(SwarmUserSchema.parse(validUser)).toEqual(validUser);
	});

	it('rejects an empty identifier', () => {
		expect(() => SwarmUserSchema.parse({ ...validUser, identifier: '' })).toThrow();
	});

	it('rejects an empty displayName', () => {
		expect(() => SwarmUserSchema.parse({ ...validUser, displayName: '' })).toThrow();
	});

	it('rejects a non-uuid id', () => {
		expect(() => SwarmUserSchema.parse({ ...validUser, id: 'not-a-uuid' })).toThrow();
	});

	it('trims a padded displayName and rejects an over-long one', () => {
		expect(SwarmUserSchema.parse({ ...validUser, displayName: '  Ada Lovelace  ' })).toEqual(
			validUser,
		);
		expect(() => SwarmUserSchema.parse({ ...validUser, displayName: 'a'.repeat(81) })).toThrow();
		expect(SwarmUserSchema.parse({ ...validUser, displayName: 'a'.repeat(80) }).displayName).toBe(
			'a'.repeat(80),
		);
	});
});

describe('UserDisplayNameSchema', () => {
	it('trims and bounds a self-editable label', () => {
		expect(UserDisplayNameSchema.parse('  Ada  ')).toBe('Ada');
		expect(() => UserDisplayNameSchema.parse('   ')).toThrow();
		expect(() => UserDisplayNameSchema.parse('')).toThrow();
		expect(() => UserDisplayNameSchema.parse('a'.repeat(81))).toThrow();
	});
});

describe('isInstanceAdmin', () => {
	it('is true only when the flag is set', () => {
		expect(isInstanceAdmin({ instanceAdmin: true })).toBe(true);
		expect(isInstanceAdmin({ instanceAdmin: false })).toBe(false);
	});
});

describe('installationRoleFor', () => {
	it('maps the flag to the named role', () => {
		expect(installationRoleFor({ instanceAdmin: true })).toBe('instanceAdmin');
		expect(installationRoleFor({ instanceAdmin: false })).toBe('user');
	});
});
