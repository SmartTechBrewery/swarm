// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { updateDisplayNameMutate, changePasswordMutate } = vi.hoisted(() => ({
	updateDisplayNameMutate: vi.fn(),
	changePasswordMutate: vi.fn(),
}));

vi.mock('@/lib/trpc.js', () => ({
	trpc: { auth: { me: { queryOptions: () => ({ queryKey: ['auth.me'] }) } } },
	trpcClient: {
		auth: {
			updateDisplayName: { mutate: updateDisplayNameMutate },
			changePassword: { mutate: changePasswordMutate },
		},
	},
}));

import { SecurityPanel } from './security-panel.js';

const CURRENT_PASSWORD = 'old-secret-value';
const NEW_PASSWORD = 'new-secret-value';

function renderPanel(displayName = 'Ada'): ReturnType<typeof render> {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	const ui: ReactElement = (
		<QueryClientProvider client={queryClient}>
			<SecurityPanel user={{ displayName }} />
		</QueryClientProvider>
	);
	return render(ui);
}

/** The three password inputs, in render order: current, new, confirm. */
function passwordInputs(container: HTMLElement): HTMLInputElement[] {
	return Array.from(container.querySelectorAll<HTMLInputElement>('input[type="password"]'));
}

function fillPasswordForm(
	container: HTMLElement,
	values: { current: string; next: string; confirm: string },
) {
	const [current, next, confirm] = passwordInputs(container);
	fireEvent.change(current, { target: { value: values.current } });
	fireEvent.change(next, { target: { value: values.next } });
	fireEvent.change(confirm, { target: { value: values.confirm } });
}

beforeEach(() => {
	updateDisplayNameMutate.mockReset().mockResolvedValue({ displayName: 'Ada Lovelace' });
	changePasswordMutate.mockReset().mockResolvedValue({ ok: true });
});

describe('SecurityPanel — display name', () => {
	it('saves the trimmed new name and reports success', async () => {
		renderPanel('Ada');

		fireEvent.change(screen.getByLabelText('Display name'), {
			target: { value: '  Ada Lovelace  ' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		await waitFor(() =>
			expect(updateDisplayNameMutate).toHaveBeenCalledWith({ displayName: 'Ada Lovelace' }),
		);
		expect(await screen.findByText('Display name updated.')).toBeDefined();
	});

	it('sends no user id — the mutation addresses the session user only', async () => {
		renderPanel('Ada');

		fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Ada Lovelace' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		await waitFor(() => expect(updateDisplayNameMutate).toHaveBeenCalledTimes(1));
		expect(Object.keys(updateDisplayNameMutate.mock.calls[0][0])).toEqual(['displayName']);
	});

	it('disables Save while the name is unchanged or emptied', () => {
		renderPanel('Ada');
		const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
		const field = screen.getByLabelText('Display name');

		expect(save.disabled).toBe(true);

		fireEvent.change(field, { target: { value: '   ' } });
		expect(save.disabled).toBe(true);

		fireEvent.change(field, { target: { value: 'Ada Lovelace' } });
		expect(save.disabled).toBe(false);
	});

	it('bounds the field at the length the server accepts', () => {
		renderPanel('Ada');
		expect(screen.getByLabelText('Display name').getAttribute('maxLength')).toBe('80');
	});

	it('states a failed rename verbatim', async () => {
		updateDisplayNameMutate.mockRejectedValue(new Error('Your account no longer exists.'));
		renderPanel('Ada');

		fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Ada Lovelace' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		expect(await screen.findByText('Your account no longer exists.')).toBeDefined();
	});
});

describe('SecurityPanel — password', () => {
	it('offers exactly three masked fields and no other text input than the name', () => {
		const { container } = renderPanel();

		expect(passwordInputs(container)).toHaveLength(3);
		// The only unmasked field on the panel is the display name.
		expect(screen.getAllByRole('textbox')).toHaveLength(1);
	});

	it('changes the password with the current one and clears every field', async () => {
		const { container } = renderPanel();

		fillPasswordForm(container, {
			current: CURRENT_PASSWORD,
			next: NEW_PASSWORD,
			confirm: NEW_PASSWORD,
		});
		fireEvent.click(screen.getByRole('button', { name: 'Change password' }));

		await waitFor(() =>
			expect(changePasswordMutate).toHaveBeenCalledWith({
				currentPassword: CURRENT_PASSWORD,
				newPassword: NEW_PASSWORD,
			}),
		);
		expect(await screen.findByText('Password changed.')).toBeDefined();
		for (const input of passwordInputs(container)) {
			expect(input.value).toBe('');
		}
	});

	it('clears every field after a failed change too, so nothing submitted is retained', async () => {
		changePasswordMutate.mockRejectedValue(new Error('Your current password is incorrect.'));
		const { container } = renderPanel();

		fillPasswordForm(container, {
			current: 'wrong-secret-value',
			next: NEW_PASSWORD,
			confirm: NEW_PASSWORD,
		});
		fireEvent.click(screen.getByRole('button', { name: 'Change password' }));

		expect(await screen.findByText('Your current password is incorrect.')).toBeDefined();
		for (const input of passwordInputs(container)) {
			expect(input.value).toBe('');
		}
	});

	it('leaves no submitted value anywhere in the rendered markup', async () => {
		const { container } = renderPanel();

		fillPasswordForm(container, {
			current: CURRENT_PASSWORD,
			next: NEW_PASSWORD,
			confirm: NEW_PASSWORD,
		});
		fireEvent.click(screen.getByRole('button', { name: 'Change password' }));

		await screen.findByText('Password changed.');
		expect(container.innerHTML).not.toContain(CURRENT_PASSWORD);
		expect(container.innerHTML).not.toContain(NEW_PASSWORD);
	});

	it('refuses a mismatched confirmation without calling the API', async () => {
		const { container } = renderPanel();

		fillPasswordForm(container, {
			current: CURRENT_PASSWORD,
			next: NEW_PASSWORD,
			confirm: 'new-secret-valu',
		});
		fireEvent.click(screen.getByRole('button', { name: 'Change password' }));

		expect(await screen.findByText('The new passwords do not match.')).toBeDefined();
		expect(changePasswordMutate).not.toHaveBeenCalled();
	});

	it('refuses a missing current password without calling the API', async () => {
		const { container } = renderPanel();

		fillPasswordForm(container, { current: '', next: NEW_PASSWORD, confirm: NEW_PASSWORD });
		fireEvent.click(screen.getByRole('button', { name: 'Change password' }));

		expect(await screen.findByText('Enter your current password.')).toBeDefined();
		expect(changePasswordMutate).not.toHaveBeenCalled();
	});

	it('refuses a new password identical to the current one without calling the API', async () => {
		const { container } = renderPanel();

		fillPasswordForm(container, {
			current: CURRENT_PASSWORD,
			next: CURRENT_PASSWORD,
			confirm: CURRENT_PASSWORD,
		});
		fireEvent.click(screen.getByRole('button', { name: 'Change password' }));

		expect(
			await screen.findByText('The new password must differ from your current one.'),
		).toBeDefined();
		expect(changePasswordMutate).not.toHaveBeenCalled();
	});
});

describe('SecurityPanel — boundaries', () => {
	it('offers no control over the identifier, the installation role, or a membership', () => {
		const { container } = renderPanel();

		// Exactly four inputs: the name plus the three password fields.
		expect(container.querySelectorAll('input')).toHaveLength(4);
		expect(container.querySelectorAll('select, textarea')).toHaveLength(0);
		expect(screen.queryAllByRole('switch')).toHaveLength(0);
		expect(screen.queryByLabelText(/identifier/i)).toBeNull();
		expect(screen.queryByLabelText(/role/i)).toBeNull();
		// Two buttons only: Save (display name) and Change password.
		expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
			'Save',
			'Change password',
		]);
	});

	it('says who owns the values it does not offer', () => {
		renderPanel();
		expect(screen.getByText(/set by an operator and cannot be changed here/)).toBeDefined();
	});
});
