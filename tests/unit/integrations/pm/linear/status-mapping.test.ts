import { describe, expect, it } from 'vitest';

import {
	requireStateIdForStatusKey,
	resolveStatusKeyByStateId,
} from '@/integrations/pm/linear/status-mapping.js';
import { createMockLinearConfig } from '../../../../helpers/factories.js';

const config = createMockLinearConfig();

describe('resolveStatusKeyByStateId', () => {
	it('inverts the configured workflow-state mapping', () => {
		expect(resolveStatusKeyByStateId(config, config.statusOptions.inProgress)).toBe('inProgress');
	});

	it('returns undefined for an unmapped state instead of guessing', () => {
		expect(resolveStatusKeyByStateId(config, 'unknown-state')).toBeUndefined();
	});
});

describe('requireStateIdForStatusKey', () => {
	it('returns a configured workflow-state UUID', () => {
		expect(requireStateIdForStatusKey(config, 'done')).toBe(config.statusOptions.done);
	});

	it('reports an unmapped canonical status as a configuration error', () => {
		expect(() => requireStateIdForStatusKey(config, 'cancelled')).toThrow(/cancelled/);
	});
});
