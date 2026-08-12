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

describe('ProfileTabBar', () => {
	it('renders only the tabs whose content is delivered', () => {
		render(<ProfileTabBar activeTab="account" onSelect={vi.fn()} />);

		expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
			'Account',
			'My Workers',
			'My Projects',
			'Security',
		]);
	});

	it('reports the tab that was clicked', () => {
		const onSelect = vi.fn();
		render(<ProfileTabBar activeTab="account" onSelect={onSelect} />);

		fireEvent.click(screen.getByRole('button', { name: 'Account' }));

		expect(onSelect).toHaveBeenCalledWith('account');
	});

	it('reports the My Workers tab that was clicked', () => {
		const onSelect = vi.fn();
		render(<ProfileTabBar activeTab="account" onSelect={onSelect} />);

		fireEvent.click(screen.getByRole('button', { name: 'My Workers' }));

		expect(onSelect).toHaveBeenCalledWith('workers');
	});

	it('reports the My Projects tab that was clicked', () => {
		const onSelect = vi.fn();
		render(<ProfileTabBar activeTab="account" onSelect={onSelect} />);

		fireEvent.click(screen.getByRole('button', { name: 'My Projects' }));

		expect(onSelect).toHaveBeenCalledWith('projects');
	});

	it('reports the Security tab that was clicked', () => {
		const onSelect = vi.fn();
		render(<ProfileTabBar activeTab="account" onSelect={onSelect} />);

		fireEvent.click(screen.getByRole('button', { name: 'Security' }));

		expect(onSelect).toHaveBeenCalledWith('security');
	});

	it('marks the active tab with the underline recipe', () => {
		render(<ProfileTabBar activeTab="account" onSelect={vi.fn()} />);

		expect(screen.getByRole('button', { name: 'Account' }).className).toContain(
			'border-violet-500',
		);
	});
});
