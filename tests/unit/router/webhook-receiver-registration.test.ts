import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProjectConfig } from '@/config/schema.js';
import { githubProjectsManifest } from '@/integrations/pm/github-projects/index.js';
import {
	_resetPMProviderRegistryForTesting,
	registerPMProvider,
} from '@/integrations/pm/registry.js';
import { createWebhookApp, type WebhookReceiverDeps } from '@/router/webhook-receiver.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

// The receiver mounts a route per *registered* PM manifest (issue #496), so these
// cases drive the real registry rather than injected fakes: one asserts the two
// tenants of `/github/webhook` both run (a shadowed second Hono handler would
// silence one of them), the other clears the registry to prove the PM handling is
// registry-sourced and not hardcoded. Vitest isolates module state per file, so the
// reset cannot leak into other suites — and the afterEach restores it anyway, so
// neither case depends on the order they run in.
describe('createWebhookApp — PM routes come from the registry', () => {
	const secret = 'topsecret';
	const project = createMockProjectConfig({ id: 'proj-1', repo: 'SmartTechBrewery/swarm' });

	afterEach(() => {
		_resetPMProviderRegistryForTesting();
		registerPMProvider(githubProjectsManifest);
	});

	function registryBackedApp() {
		const enqueue = vi.fn<WebhookReceiverDeps['enqueue']>().mockResolvedValue(undefined);
		const enqueuePm = vi.fn<WebhookReceiverDeps['enqueuePm']>().mockResolvedValue(undefined);
		const app = createWebhookApp({
			findProject: vi
				.fn<(repo: string) => Promise<ProjectConfig | undefined>>()
				.mockResolvedValue(project),
			findProjectByBoard: vi
				.fn<(id: string) => Promise<ProjectConfig | undefined>>()
				.mockResolvedValue(project),
			getWebhookSecret: vi.fn<WebhookReceiverDeps['getWebhookSecret']>().mockResolvedValue(secret),
			// The board half resolves the PM provider's own `webhookSecret` role (issue
			// #497); for GitHub Projects that role inherits `credentials.webhookSecret`,
			// so it resolves to the same secret the repo half uses.
			getPmCredential: vi.fn<WebhookReceiverDeps['getPmCredential']>().mockResolvedValue(secret),
			enqueue,
			enqueuePm,
		});
		return { app, enqueue, enqueuePm };
	}

	function post(app: ReturnType<typeof createWebhookApp>, eventName: string, body: string) {
		return app.request('/github/webhook', {
			method: 'POST',
			headers: {
				'x-github-event': eventName,
				'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`,
				'x-github-delivery': `delivery-${eventName}`,
				'content-type': 'application/json',
			},
			body,
		});
	}

	const repoBody = JSON.stringify({
		action: 'opened',
		repository: { full_name: 'SmartTechBrewery/swarm' },
		pull_request: { number: 1, head: { sha: 'abc', ref: 'issue-1' } },
		sender: { login: 'human-dev' },
	});
	const boardBody = JSON.stringify({
		action: 'created',
		projects_v2_item: { node_id: 'PVTI_1', project_node_id: 'PVT_1' },
	});

	it('serves the SCM provider and its co-tenant PM provider on the one shared route', async () => {
		const { app, enqueue, enqueuePm } = registryBackedApp();

		expect((await post(app, 'pull_request', repoBody)).status).toBe(202);
		expect((await post(app, 'projects_v2_item', boardBody)).status).toBe(202);

		// Both tenants ran: a PM manifest mounted as a *second* `app.post()` on this
		// path would be shadowed by the SCM handler and never enqueue anything.
		expect(enqueue).toHaveBeenCalledWith(
			'github',
			expect.objectContaining({ kind: 'pull-request' }),
			project,
			'delivery-pull_request',
		);
		expect(enqueuePm).toHaveBeenCalledWith(
			'github-projects',
			expect.objectContaining({ itemId: 'PVTI_1', containerId: 'PVT_1' }),
			project,
			'delivery-projects_v2_item',
		);
	});

	it('handles no board event when no PM manifest is registered', async () => {
		_resetPMProviderRegistryForTesting();
		const { app, enqueuePm } = registryBackedApp();

		// With nothing registered there is no co-tenant to offer the event to, so the
		// SCM provider answers — and acknowledges an event it doesn't handle.
		const res = await post(app, 'projects_v2_item', boardBody);
		expect(res.status).toBe(202);
		expect((await res.json()).reason).toBe('unhandled event type: projects_v2_item');
		expect(enqueuePm).not.toHaveBeenCalled();
	});
});
