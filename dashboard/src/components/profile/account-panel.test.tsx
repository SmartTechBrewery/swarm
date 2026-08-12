// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AccountPanel, type AccountUser } from './account-panel.js';

function makeUser(overrides: Partial<AccountUser> = {}): AccountUser {
	return {
		displayName: 'Ada Lovelace',
		identifier: 'ada@example.com',
		instanceAdmin: false,
		...overrides,
	};
}

describe('AccountPanel', () => {
	it('states the display name and login identifier of the signed-in user', () => {
		render(<AccountPanel user={makeUser()} />);

		expect(screen.getByText('Display name')).toBeDefined();
		expect(screen.getByText('Ada Lovelace')).toBeDefined();
		expect(screen.getByText('Login identifier')).toBeDefined();
		expect(screen.getByText('ada@example.com')).toBeDefined();
	});

	it('renders the identifier as a machine value and the name as prose', () => {
		render(<AccountPanel user={makeUser()} />);

		// ai/DESIGN_SYSTEM.md §2: the mono/sans split is how a user tells a value
		// the system generated from one a human wrote.
		expect(screen.getByText('ada@example.com').className).toContain('font-mono');
		expect(screen.getByText('Ada Lovelace').className).not.toContain('font-mono');
	});

	it('names the installation role of an ordinary user', () => {
		render(<AccountPanel user={makeUser()} />);

		expect(screen.getByText('Installation role')).toBeDefined();
		expect(screen.getByText('User')).toBeDefined();
		expect(screen.queryByText('Instance administrator')).toBeNull();
	});

	it('names the installation role of an instance administrator', () => {
		render(<AccountPanel user={makeUser({ instanceAdmin: true })} />);

		expect(screen.getByText('Instance administrator')).toBeDefined();
		expect(screen.queryByText('User')).toBeNull();
	});

	it('names who owns each value — the operator, except the self-editable name', () => {
		render(<AccountPanel user={makeUser()} />);

		expect(
			screen.getByText(/login identifier and installation\s+role are read-only/),
		).toBeDefined();
		expect(
			screen.getByText(/display name is yours to change, on\s+the Security tab/),
		).toBeDefined();
	});

	it('is read-only — it offers no control', () => {
		const { container } = render(<AccountPanel user={makeUser({ instanceAdmin: true })} />);

		expect(screen.queryAllByRole('textbox')).toHaveLength(0);
		expect(screen.queryAllByRole('button')).toHaveLength(0);
		expect(screen.queryAllByRole('switch')).toHaveLength(0);
		expect(container.querySelectorAll('input, select, textarea')).toHaveLength(0);
	});
});
