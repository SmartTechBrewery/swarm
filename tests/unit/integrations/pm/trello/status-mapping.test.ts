import { describe, expect, it } from 'vitest';

import {
	requireListIdForStatusKey,
	resolveStatusKeyByListId,
} from '@/integrations/pm/trello/status-mapping.js';
import { createMockTrelloConfig } from '../../../../helpers/factories.js';

const config = createMockTrelloConfig();

describe('resolveStatusKeyByListId', () => {
	it('inverts the configured list mapping', () => {
		expect(resolveStatusKeyByListId(config, config.statusOptions.inProgress)).toBe('inProgress');
	});

	it('returns undefined for an unmapped list instead of guessing', () => {
		expect(resolveStatusKeyByListId(config, '6a1b2c3d4e5f60718293a4ff')).toBeUndefined();
	});
});

describe('requireListIdForStatusKey', () => {
	it('returns a configured Trello list id', () => {
		expect(requireListIdForStatusKey(config, 'done')).toBe(config.statusOptions.done);
	});

	it('reports an unmapped canonical status as a configuration error', () => {
		expect(() => requireListIdForStatusKey(config, 'cancelled')).toThrow(/cancelled/);
	});
});
