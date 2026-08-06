import { describe, expect, it } from 'vitest';
import { createTriggerRegistry } from '@/triggers/registry.js';
import type { TriggerContext, TriggerHandler, TriggerResult } from '@/triggers/types.js';
import { createMockScmTriggerContext } from '../../helpers/factories.js';

function makeContext(): TriggerContext {
	return createMockScmTriggerContext({ deliveryId: 'delivery-uuid-1' });
}

function makeResult(taskId = '17'): TriggerResult {
	return {
		phase: 'review',
		taskId,
		prNumber: taskId,
		prBranch: `issue-${taskId}`,
		headSha: 'deadbeef',
	};
}

function makeHandler(overrides: Partial<TriggerHandler> = {}): TriggerHandler {
	return {
		name: 'test-handler',
		description: 'a test handler',
		matches: () => true,
		handle: async () => makeResult(),
		...overrides,
	};
}

describe('TriggerRegistry', () => {
	it('dispatches to the first matching handler', async () => {
		const registry = createTriggerRegistry();
		const first = makeResult('first');
		const invoked: string[] = [];
		registry.register(
			makeHandler({
				name: 'first',
				handle: async () => {
					invoked.push('first');
					return first;
				},
			}),
		);
		registry.register(
			makeHandler({
				name: 'second',
				handle: async () => {
					invoked.push('second');
					return makeResult('second');
				},
			}),
		);

		await expect(registry.dispatch(makeContext())).resolves.toBe(first);
		expect(invoked).toEqual(['first']);
	});

	it('skips non-matching handlers without invoking them', async () => {
		const registry = createTriggerRegistry();
		const invoked: string[] = [];
		registry.register(
			makeHandler({
				name: 'skipped',
				matches: () => false,
				handle: async () => {
					invoked.push('skipped');
					return makeResult();
				},
			}),
		);
		const result = makeResult();
		registry.register(makeHandler({ name: 'hit', handle: async () => result }));

		await expect(registry.dispatch(makeContext())).resolves.toBe(result);
		expect(invoked).toEqual([]);
	});

	it('continues past a matching handler that returns null', async () => {
		const registry = createTriggerRegistry();
		registry.register(makeHandler({ name: 'declines', handle: async () => null }));
		const result = makeResult();
		registry.register(makeHandler({ name: 'accepts', handle: async () => result }));

		await expect(registry.dispatch(makeContext())).resolves.toBe(result);
	});

	it('returns null when no handler matches', async () => {
		const registry = createTriggerRegistry();
		registry.register(makeHandler({ matches: () => false }));

		await expect(registry.dispatch(makeContext())).resolves.toBeNull();
	});

	it('propagates a handler error', async () => {
		const registry = createTriggerRegistry();
		registry.register(
			makeHandler({
				handle: async () => {
					throw new Error('handler exploded');
				},
			}),
		);

		await expect(registry.dispatch(makeContext())).rejects.toThrow('handler exploded');
	});

	it('unregisters a handler by name', async () => {
		const registry = createTriggerRegistry();
		registry.register(makeHandler({ name: 'removable' }));

		expect(registry.unregister('removable')).toBe(true);
		expect(registry.unregister('removable')).toBe(false);
		await expect(registry.dispatch(makeContext())).resolves.toBeNull();
	});

	it('getHandlers returns a copy, not the live list', () => {
		const registry = createTriggerRegistry();
		registry.register(makeHandler());

		registry.getHandlers().pop();
		expect(registry.getHandlers()).toHaveLength(1);
	});
});
