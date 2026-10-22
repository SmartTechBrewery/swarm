import { describe, expect, it } from 'vitest';
import { MERGE_CATCH_UP_ACTION } from '@/queue/jobs.js';
import { registerBuiltInTriggers } from '@/triggers/builtins.js';
import { createTriggerRegistry } from '@/triggers/registry.js';
import { createFakeScmProvider, createMockScmTriggerContext } from '../../helpers/factories.js';

describe('registerBuiltInTriggers', () => {
	it('registers all pipeline-phase handlers', () => {
		const registry = createTriggerRegistry();
		registerBuiltInTriggers(registry);

		const names = registry.getHandlers().map((h) => h.name);
		expect(names).toEqual([
			'pr-review',
			'resolve-conflicts',
			'pr-review-submitted',
			'pm-status-changed',
		]);
	});

	it('registers no handler that no served webhook event can reach (issue #737)', () => {
		const registry = createTriggerRegistry();
		registerBuiltInTriggers(registry);

		// `preplan-invalidated` required a `work-item` event, which only GitHub's
		// `issues` event maps to — an event the repository webhook does not subscribe
		// to — so it read as live while being dead. Its replacement is one rule on the
		// `planned` label, handled by `pm-status-changed`.
		expect(registry.getHandlers().map((h) => h.name)).not.toContain('preplan-invalidated');
	});

	it('registers every handler with a description', () => {
		const registry = createTriggerRegistry();
		registerBuiltInTriggers(registry);

		for (const handler of registry.getHandlers()) {
			expect(handler.description.length).toBeGreaterThan(0);
		}
	});

	// Issue #1117: merge automation's catch-up job must reach the one handler that
	// knows its marker — first-match-wins would otherwise let another take it.
	it('routes the merge catch-up job to resolve-conflicts alone', () => {
		const registry = createTriggerRegistry();
		registerBuiltInTriggers(registry);
		const ctx = createMockScmTriggerContext({
			scm: createFakeScmProvider({}),
			mergeCatchUp: { reviewRunId: 'run-1', headSha: 'abc' },
			event: {
				kind: 'pull-request',
				action: MERGE_CATCH_UP_ACTION,
				repoFullName: 'acme/widgets',
				workItemId: '42',
				isCommentEvent: false,
				headSha: 'abc',
			},
		});

		expect(
			registry
				.getHandlers()
				.filter((handler) => handler.matches(ctx))
				.map((handler) => handler.name),
		).toEqual(['resolve-conflicts']);
	});
});
