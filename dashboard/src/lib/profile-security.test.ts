import { describe, expect, it } from 'vitest';
import {
	canSaveDisplayName,
	DISPLAY_NAME_MAX_LENGTH,
	describePasswordFormError,
} from './profile-security.js';

describe('canSaveDisplayName', () => {
	it('allows a trimmed, changed, in-bounds name', () => {
		expect(canSaveDisplayName('Ada Lovelace', 'Ada')).toBe(true);
		expect(canSaveDisplayName('  Ada Lovelace  ', 'Ada')).toBe(true);
	});

	it('refuses a name that is unchanged once trimmed', () => {
		expect(canSaveDisplayName('Ada', 'Ada')).toBe(false);
		expect(canSaveDisplayName('  Ada  ', 'Ada')).toBe(false);
	});

	it('refuses an empty or whitespace-only name', () => {
		expect(canSaveDisplayName('', 'Ada')).toBe(false);
		expect(canSaveDisplayName('   ', 'Ada')).toBe(false);
	});

	it('refuses a name longer than the server allows', () => {
		expect(canSaveDisplayName('a'.repeat(DISPLAY_NAME_MAX_LENGTH), 'Ada')).toBe(true);
		expect(canSaveDisplayName('a'.repeat(DISPLAY_NAME_MAX_LENGTH + 1), 'Ada')).toBe(false);
	});
});

describe('describePasswordFormError', () => {
	const filled = { current: 'old-secret', next: 'new-secret', confirm: 'new-secret' };

	it('reports no problem with a submittable form', () => {
		expect(describePasswordFormError(filled)).toBeNull();
	});

	it('asks for each missing field', () => {
		expect(describePasswordFormError({ ...filled, current: '' })).toBe(
			'Enter your current password.',
		);
		expect(describePasswordFormError({ ...filled, next: '', confirm: '' })).toBe(
			'Enter a new password.',
		);
	});

	it('catches a mistyped confirmation', () => {
		expect(describePasswordFormError({ ...filled, confirm: 'new-secrat' })).toBe(
			'The new passwords do not match.',
		);
	});

	it('refuses a change that changes nothing', () => {
		expect(
			describePasswordFormError({
				current: 'same-secret',
				next: 'same-secret',
				confirm: 'same-secret',
			}),
		).toBe('The new password must differ from your current one.');
	});

	it('never echoes a submitted value in its message', () => {
		const messages = [
			describePasswordFormError({ ...filled, confirm: 'new-secrat' }),
			describePasswordFormError({ current: 'x', next: 'x', confirm: 'x' }),
			describePasswordFormError({ ...filled, current: '' }),
		];
		for (const message of messages) {
			expect(message).not.toContain('secret');
			expect(message).not.toContain('secrat');
		}
	});
});
