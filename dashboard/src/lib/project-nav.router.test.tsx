// @vitest-environment jsdom

import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
	useNavigate,
} from '@tanstack/react-router';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
	agentConfigSearch,
	type ProjectDetailSearch,
	phaseDetailSearch,
	projectDetailSearchSchema,
	resolveActiveTab,
	tabSearch,
} from './project-nav.js';

// A stub for the project-detail screen that mirrors only the navigation contract
// (issue #210): the Agent Configuration tab drills into a phase detail, and the
// tab/phase live in the URL via the real search schema + helpers. Rendering the
// full route would require the tRPC provider; the routing behavior under test —
// browser Back/Forward and deep links — is independent of that.
function StubProjectDetail() {
	const search = projectRoute.useSearch();
	const navigate = useNavigate();
	const activeTab = resolveActiveTab(search);
	const go = (next: ProjectDetailSearch) =>
		navigate({ to: '/projects/$projectId', params: { projectId: 'p1' }, search: next });

	if (activeTab === 'agents' && search.phase) {
		return (
			<div>
				<div>phase-detail:{search.phase}</div>
				<button type="button" onClick={() => go(agentConfigSearch())}>
					Back to Agent Configuration
				</button>
			</div>
		);
	}
	if (activeTab === 'agents') {
		return (
			<div>
				<div>agent-config-summary</div>
				<button type="button" onClick={() => go(phaseDetailSearch('review'))}>
					Open Review
				</button>
			</div>
		);
	}
	return (
		<div>
			<div>tab:{activeTab}</div>
			<button type="button" onClick={() => go(tabSearch('agents'))}>
				Agent Configuration
			</button>
			<button type="button" onClick={() => go(tabSearch('workers'))}>
				Workers
			</button>
		</div>
	);
}

const rootRoute = createRootRoute({ component: () => <Outlet /> });
const projectRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/projects/$projectId',
	validateSearch: (search) => projectDetailSearchSchema.parse(search),
	component: StubProjectDetail,
});
const routeTree = rootRoute.addChildren([projectRoute]);

function renderAt(initialEntry: string) {
	const router = createRouter({
		routeTree,
		history: createMemoryHistory({ initialEntries: [initialEntry] }),
	});
	render(<RouterProvider router={router} />);
	return router;
}

describe('Agent Configuration browser-history navigation', () => {
	it('returns to the Agent Configuration summary on Back, then to the preceding tab', async () => {
		const router = renderAt('/projects/p1');
		expect(await screen.findByText('tab:runs')).toBeDefined();

		fireEvent.click(screen.getByText('Agent Configuration'));
		expect(await screen.findByText('agent-config-summary')).toBeDefined();

		fireEvent.click(screen.getByText('Open Review'));
		expect(await screen.findByText('phase-detail:review')).toBeDefined();

		// Browser Back → Agent Configuration summary (not the Runs tab / prior page).
		act(() => router.history.back());
		expect(await screen.findByText('agent-config-summary')).toBeDefined();

		// A subsequent Back → the tab that preceded Agent Configuration.
		act(() => router.history.back());
		expect(await screen.findByText('tab:runs')).toBeDefined();

		// Browser Forward restores the summary, then the same phase-details view.
		act(() => router.history.forward());
		expect(await screen.findByText('agent-config-summary')).toBeDefined();
		act(() => router.history.forward());
		expect(await screen.findByText('phase-detail:review')).toBeDefined();
	});

	it('opens a phase detail as a distinct history entry', async () => {
		const router = renderAt('/projects/p1');
		fireEvent.click(await screen.findByText('Agent Configuration'));
		fireEvent.click(await screen.findByText('Open Review'));
		await screen.findByText('phase-detail:review');
		expect(router.state.location.search).toEqual({ tab: 'agents', phase: 'review' });
	});

	it('the in-app Back to Agent Configuration control returns to the summary', async () => {
		renderAt('/projects/p1?tab=agents&phase=review');
		expect(await screen.findByText('phase-detail:review')).toBeDefined();

		fireEvent.click(screen.getByText('Back to Agent Configuration'));
		expect(await screen.findByText('agent-config-summary')).toBeDefined();
	});

	it('renders a phase-details view from a direct deep link', async () => {
		renderAt('/projects/p1?tab=agents&phase=review');
		expect(await screen.findByText('phase-detail:review')).toBeDefined();
	});

	it('falls back to the summary for a deep link with an unknown phase', async () => {
		renderAt('/projects/p1?tab=agents&phase=bogus');
		expect(await screen.findByText('agent-config-summary')).toBeDefined();
	});
});

describe('Workers tab navigation (issue #574)', () => {
	it('renders the Workers tab from a direct deep link', async () => {
		renderAt('/projects/p1?tab=workers');
		expect(await screen.findByText('tab:workers')).toBeDefined();
	});

	it('opens as its own history entry, so Back returns to the preceding tab', async () => {
		const router = renderAt('/projects/p1');
		expect(await screen.findByText('tab:runs')).toBeDefined();

		fireEvent.click(screen.getByText('Workers'));
		expect(await screen.findByText('tab:workers')).toBeDefined();
		expect(router.state.location.search).toEqual({ tab: 'workers' });

		act(() => router.history.back());
		expect(await screen.findByText('tab:runs')).toBeDefined();
	});
});
