// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PROFILE_TABS } from '@/lib/profile-nav.js';
import { PROFILE_TAB_ITEMS, ProfileTabBar } from './profile.js';

describe('PROFILE_TAB_ITEMS', () => {
	it('covers the URL vocabulary in the same order', () => {
		// The rendered order and the `?tab=` values are the same navigation
		// structure stated twice; this keeps them from drifting apart.
		expect(PROFILE_TAB_ITEMS.map(({ tab }) => tab)).toEqual([...PROFILE_TABS]);
	});
});

const MEMBER = { instanceAdmin: false };
const ADMIN = { instanceAdmin: true };

describe('ProfileTabBar', () => {
	// Issue #1457: the MCP tab is every signed-in user's, whatever their role or
	// project membership — the viewer carries no membership, so none is consulted.
	it.each([
		['a user with no installation role', MEMBER],
		['an installation administrator', ADMIN],
	])('renders every delivered tab, MCP included, for %s', (_, viewer) => {
		const onSelect = vi.fn();
		render(<ProfileTabBar activeTab="account" viewer={viewer} onSelect={onSelect} />);

		expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
			'Account',
			'My Workers',
			'My Projects',
			'Security',
			'MCP',
		]);
		fireEvent.click(screen.getByRole('button', { name: 'MCP' }));
		expect(onSelect).toHaveBeenCalledWith('mcp');
	});

	it('reports the tab that was clicked', () => {
		const onSelect = vi.fn();
		render(<ProfileTabBar activeTab="account" viewer={MEMBER} onSelect={onSelect} />);

		fireEvent.click(screen.getByRole('button', { name: 'Account' }));

		expect(onSelect).toHaveBeenCalledWith('account');
	});

	it('reports the My Workers tab that was clicked', () => {
		const onSelect = vi.fn();
		render(<ProfileTabBar activeTab="account" viewer={MEMBER} onSelect={onSelect} />);

		fireEvent.click(screen.getByRole('button', { name: 'My Workers' }));

		expect(onSelect).toHaveBeenCalledWith('workers');
	});

	it('reports the My Projects tab that was clicked', () => {
		const onSelect = vi.fn();
		render(<ProfileTabBar activeTab="account" viewer={MEMBER} onSelect={onSelect} />);

		fireEvent.click(screen.getByRole('button', { name: 'My Projects' }));

		expect(onSelect).toHaveBeenCalledWith('projects');
	});

	it('reports the Security tab that was clicked', () => {
		const onSelect = vi.fn();
		render(<ProfileTabBar activeTab="account" viewer={MEMBER} onSelect={onSelect} />);

		fireEvent.click(screen.getByRole('button', { name: 'Security' }));

		expect(onSelect).toHaveBeenCalledWith('security');
	});

	it('marks the active tab with the underline recipe', () => {
		render(<ProfileTabBar activeTab="account" viewer={MEMBER} onSelect={vi.fn()} />);

		expect(screen.getByRole('button', { name: 'Account' }).className).toContain(
			'border-violet-500',
		);
	});
});
