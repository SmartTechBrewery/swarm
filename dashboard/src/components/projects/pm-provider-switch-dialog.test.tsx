// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PmProviderSwitchDialog } from './pm-provider-switch-dialog.js';

function renderDialog(overrides: { open?: boolean } = {}) {
	const onConfirm = vi.fn();
	const onCancel = vi.fn();
	render(
		<PmProviderSwitchDialog
			open={overrides.open ?? true}
			fromProviderId="github-projects"
			toProviderId="linear"
			isPending={false}
			onConfirm={onConfirm}
			onCancel={onCancel}
		/>,
	);
	return { onConfirm, onCancel };
}

describe('PmProviderSwitchDialog (issue #642)', () => {
	it('names the outgoing and incoming providers from the mapping catalogue', () => {
		renderDialog();

		expect(screen.getByText(/moving it from/)).not.toBeNull();
		expect(screen.getByText('GitHub Projects')).not.toBeNull();
		expect(screen.getByText('Linear')).not.toBeNull();
		expect(screen.getByRole('button', { name: 'Switch to Linear' })).not.toBeNull();
	});

	// The #628 decision, carried to the PM side by #631's per-provider blocks: the
	// outgoing provider's secrets are retained, so switching back needs no re-entry.
	it('states that the outgoing provider’s credentials are kept', () => {
		renderDialog();

		expect(screen.getByText(/credentials are/)).not.toBeNull();
		expect(screen.getByText('kept')).not.toBeNull();
	});

	// The open question #631 handed to this phase, decided rather than omitted: a switch
	// is not refused while runs are active, so the consequence is stated instead.
	it('states that work already in flight is not migrated', () => {
		renderDialog();

		expect(screen.getByText(/Work already in flight is not migrated/)).not.toBeNull();
		expect(screen.getByText(/will not resolve on the Linear one/)).not.toBeNull();
	});

	it('confirms and cancels through its own callbacks', () => {
		const { onConfirm, onCancel } = renderDialog();

		fireEvent.click(screen.getByRole('button', { name: 'Switch to Linear' }));
		expect(onConfirm).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it('renders nothing while closed', () => {
		renderDialog({ open: false });

		expect(screen.queryByText(/Work already in flight/)).toBeNull();
	});
});
