// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { deleteMutate } = vi.hoisted(() => ({ deleteMutate: vi.fn() }));

vi.mock('@/lib/trpc.js', () => ({
	trpcClient: { projects: { delete: { mutate: deleteMutate } } },
}));

import { ProjectDeleteCard } from './project-delete-card.js';

const onDeleted = vi.fn();

function renderCard() {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={queryClient}>
			<ProjectDeleteCard projectId="giotto-demo" projectName="Giotto" onDeleted={onDeleted} />
		</QueryClientProvider>,
	);
}

/** The modal's copy of the action, which shares its name with the entry point. */
function confirmButton(): HTMLElement {
	const buttons = screen.getAllByRole('button', { name: 'Delete project' });
	return buttons[buttons.length - 1];
}

/** Open the confirmation and type the project id back, the state confirm needs. */
function openAndArm() {
	fireEvent.click(screen.getByRole('button', { name: 'Delete project' }));
	fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: 'giotto-demo' } });
}

beforeEach(() => {
	deleteMutate.mockReset();
	deleteMutate.mockResolvedValue(undefined);
	onDeleted.mockReset();
});

describe('ProjectDeleteCard (issue #854)', () => {
	it('does not delete on the first click — the confirmation comes first', () => {
		renderCard();

		fireEvent.click(screen.getByRole('button', { name: 'Delete project' }));

		expect(screen.getByRole('heading', { name: 'Delete this project?' })).toBeDefined();
		expect(deleteMutate).not.toHaveBeenCalled();
	});

	it('deletes on confirmation and reports it to the caller', async () => {
		renderCard();

		openAndArm();
		fireEvent.click(confirmButton());

		await waitFor(() => expect(deleteMutate).toHaveBeenCalledWith({ id: 'giotto-demo' }));
		await waitFor(() => expect(onDeleted).toHaveBeenCalled());
	});

	it('cancelling closes the confirmation without mutating', () => {
		renderCard();

		openAndArm();
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(screen.queryByRole('heading', { name: 'Delete this project?' })).toBeNull();
		expect(deleteMutate).not.toHaveBeenCalled();
	});

	it('dismissing with Escape deletes nothing', () => {
		renderCard();

		openAndArm();
		fireEvent.keyDown(window, { key: 'Escape' });

		expect(screen.queryByRole('heading', { name: 'Delete this project?' })).toBeNull();
		expect(deleteMutate).not.toHaveBeenCalled();
	});

	// The blast radius the acceptance criteria ask the operator not to have to guess at.
	it('names the project and what the cascade takes with it', () => {
		renderCard();

		fireEvent.click(screen.getByRole('button', { name: 'Delete project' }));

		expect(screen.getByText(/Giotto/)).toBeDefined();
		expect(screen.getByText(/entire run history/)).toBeDefined();
		expect(screen.getByText(/source-control and project-management credentials/)).toBeDefined();
		expect(screen.getByText(/its members, and any pending requests/)).toBeDefined();
		expect(screen.getByText(/review verdicts/)).toBeDefined();
		expect(screen.getByText(/enrollment in it/)).toBeDefined();
		// And what survives, so the repository isn't assumed lost too.
		expect(screen.getByText(/repository itself/)).toBeDefined();
	});

	it('keeps confirm inert until the project id is typed back', () => {
		renderCard();

		fireEvent.click(screen.getByRole('button', { name: 'Delete project' }));
		expect(confirmButton().hasAttribute('disabled')).toBe(true);

		fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: 'giotto' } });
		expect(confirmButton().hasAttribute('disabled')).toBe(true);

		fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: 'giotto-demo' } });
		expect(confirmButton().hasAttribute('disabled')).toBe(false);
	});

	it('shows the server’s refusal verbatim, leaving the confirmation open', async () => {
		deleteMutate.mockRejectedValue(
			new Error('This project has 2 runs in flight. Wait for them to finish.'),
		);
		renderCard();

		openAndArm();
		fireEvent.click(confirmButton());

		expect(
			await screen.findByText('This project has 2 runs in flight. Wait for them to finish.'),
		).toBeDefined();
		expect(screen.getByRole('heading', { name: 'Delete this project?' })).toBeDefined();
		expect(onDeleted).not.toHaveBeenCalled();
	});
});
