// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { listQuery, issueMutate, revokeMutate } = vi.hoisted(() => ({
	listQuery: vi.fn(),
	issueMutate: vi.fn(),
	revokeMutate: vi.fn(),
}));

vi.mock('@/lib/trpc.js', () => ({
	trpc: {
		agentAccessTokens: {
			list: {
				queryOptions: () => ({ queryKey: ['agentAccessTokens.list'], queryFn: listQuery }),
			},
		},
	},
	trpcClient: {
		agentAccessTokens: {
			issue: { mutate: issueMutate },
			revoke: { mutate: revokeMutate },
		},
	},
}));

import { McpPanel } from './mcp-panel.js';

const DAY = 24 * 60 * 60 * 1000;
const LIVE = {
	id: '33333333-3333-4333-8333-333333333333',
	name: 'office laptop',
	createdAt: new Date(Date.now() - DAY).toISOString(),
	expiresAt: new Date(Date.now() + 29 * DAY).toISOString(),
	lastUsedAt: new Date(Date.now() - 60_000).toISOString(),
};
const EXPIRED = {
	id: '44444444-4444-4444-8444-444444444444',
	name: 'old box',
	createdAt: new Date(Date.now() - 40 * DAY).toISOString(),
	expiresAt: new Date(Date.now() - 10 * DAY).toISOString(),
};
const RAW_TOKEN = 'raw-token-value-0123456789';

let queryClient: QueryClient;

function renderPanel() {
	queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return render(
		<QueryClientProvider client={queryClient}>
			<McpPanel />
		</QueryClientProvider>,
	);
}

async function issueToken(name = 'ci runner') {
	fireEvent.change(await screen.findByLabelText('Token name'), { target: { value: name } });
	fireEvent.click(screen.getByRole('button', { name: 'Issue token' }));
	return screen.findByRole('dialog', { name: 'Token issued' });
}

beforeEach(() => {
	listQuery.mockReset().mockResolvedValue([LIVE, EXPIRED]);
	issueMutate.mockReset().mockResolvedValue({ ...LIVE, name: 'ci runner', token: RAW_TOKEN });
	revokeMutate.mockReset().mockResolvedValue({ ok: true });
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('McpPanel — states', () => {
	it('shows a skeleton while the list loads', () => {
		listQuery.mockReturnValue(new Promise(() => {}));
		renderPanel();

		expect(screen.getByTestId('mcp-skeleton')).toBeDefined();
	});

	it('shows the empty state when there is no token', async () => {
		listQuery.mockResolvedValue([]);
		renderPanel();

		expect(await screen.findByText('You have no token yet')).toBeDefined();
		expect(screen.getByLabelText('Token name')).toBeDefined();
	});

	it('shows a read error with a working retry', async () => {
		listQuery.mockRejectedValueOnce(new Error('boom'));
		renderPanel();

		expect(await screen.findByText('Agent access tokens are unavailable')).toBeDefined();
		fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
		expect(await screen.findByText('office laptop')).toBeDefined();
	});

	it('lists each token with its dates, flagging an expired one', async () => {
		renderPanel();

		const live = (await screen.findByText('office laptop')).closest('li') as HTMLElement;
		expect(live.textContent).toMatch(/Issued .* · Expires .* · Last used /);
		expect(within(live).queryByText('Expired')).toBeNull();

		const expired = screen.getByText('old box').closest('li') as HTMLElement;
		expect(expired.textContent).toMatch(/Expired .* · Not used yet/);
		expect(within(expired).getByText('Expired')).toBeDefined();
	});
});

describe('McpPanel — issuing', () => {
	it('refuses a blank name without sending anything', async () => {
		renderPanel();

		fireEvent.change(await screen.findByLabelText('Token name'), { target: { value: '   ' } });
		fireEvent.click(screen.getByRole('button', { name: 'Issue token' }));

		expect(await screen.findByText('A token name is required.')).toBeDefined();
		expect(issueMutate).not.toHaveBeenCalled();
	});

	it('shows a server refusal and keeps the name', async () => {
		issueMutate.mockRejectedValue(new Error('Only installation administrators can hold tokens.'));
		renderPanel();

		fireEvent.change(await screen.findByLabelText('Token name'), { target: { value: 'laptop' } });
		fireEvent.click(screen.getByRole('button', { name: 'Issue token' }));

		expect(
			await screen.findByText('Only installation administrators can hold tokens.'),
		).toBeDefined();
		expect((screen.getByLabelText('Token name') as HTMLInputElement).value).toBe('laptop');
	});

	it('reveals the token once with the Claude Code command for this installation', async () => {
		renderPanel();

		const dialog = await issueToken('  ci runner ');

		expect(issueMutate).toHaveBeenCalledWith({ name: 'ci runner' });
		expect(within(dialog).getByText(RAW_TOKEN)).toBeDefined();
		expect(dialog.querySelector('pre')?.textContent).toBe(
			`claude mcp add --transport http swarm ${window.location.origin}/operator/mcp \\\n` +
				`  --header "Authorization: Bearer ${RAW_TOKEN}"`,
		);
		expect(within(dialog).getByText(/only time this token is shown/)).toBeDefined();
		expect(within(dialog).getByText(/works only on the installation that issued it/)).toBeDefined();
		expect(within(dialog).getByRole('status')).toBeDefined();
	});

	it('copies the token and the command, reporting each', async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
		renderPanel();
		const dialog = await issueToken();

		fireEvent.click(within(dialog).getByRole('button', { name: 'Copy token' }));
		expect(await within(dialog).findByText('Token copied')).toBeDefined();
		expect(writeText).toHaveBeenCalledWith(RAW_TOKEN);

		fireEvent.click(within(dialog).getByRole('button', { name: 'Copy command' }));
		expect(await within(dialog).findByText('Command copied')).toBeDefined();
		expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining('claude mcp add'));
	});

	it('asks for a manual copy when the clipboard is missing', async () => {
		vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
		renderPanel();
		const dialog = await issueToken();

		fireEvent.click(within(dialog).getByRole('button', { name: 'Copy token' }));

		expect(
			await within(dialog).findByText('Could not copy — select the text and copy it manually.'),
		).toBeDefined();
	});

	it('closes only through Close, dropping the raw token from the screen and the cache', async () => {
		renderPanel();
		const dialog = await issueToken();

		fireEvent.click(dialog.parentElement as HTMLElement);
		fireEvent.keyDown(window, { key: 'Escape' });
		expect(screen.getByRole('dialog', { name: 'Token issued' })).toBeDefined();

		fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));

		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		expect(screen.queryByText(RAW_TOKEN)).toBeNull();
		await waitFor(() =>
			expect(
				JSON.stringify(
					queryClient
						.getMutationCache()
						.getAll()
						.map((m) => m.state),
				),
			).not.toContain(RAW_TOKEN),
		);
	});
});

describe('McpPanel — revoking', () => {
	it('confirms, then revokes the chosen token', async () => {
		renderPanel();

		fireEvent.click(await screen.findByRole('button', { name: 'Revoke token office laptop' }));
		const dialog = screen.getByRole('dialog', { name: 'Revoke token?' });
		expect(dialog.textContent).toMatch(/rejected by the MCP server immediately/);
		expect(dialog.textContent).toMatch(/cannot be undone/);

		fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke token' }));

		await waitFor(() => expect(revokeMutate).toHaveBeenCalledWith({ tokenId: LIVE.id }));
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
	});

	it('keeps a refusal inside the open dialog', async () => {
		revokeMutate.mockRejectedValue(new Error('You have no agent access token with this id.'));
		renderPanel();

		fireEvent.click(await screen.findByRole('button', { name: 'Revoke token office laptop' }));
		const dialog = screen.getByRole('dialog', { name: 'Revoke token?' });
		fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke token' }));

		expect(
			await within(dialog).findByText('You have no agent access token with this id.'),
		).toBeDefined();
		expect(screen.getByRole('dialog', { name: 'Revoke token?' })).toBeDefined();
	});
});
