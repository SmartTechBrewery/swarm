import { describe, expect, it } from 'vitest';
import { registerBuiltInTriggers } from '@/triggers/builtins.js';
import { createTriggerRegistry } from '@/triggers/registry.js';

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
});
