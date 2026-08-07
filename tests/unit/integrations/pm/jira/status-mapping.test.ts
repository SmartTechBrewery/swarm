import { describe, expect, it } from 'vitest';

import {
	requireStatusIdForStatusKey,
	resolveStatusKeyByStatusId,
} from '@/integrations/pm/jira/status-mapping.js';
import { createMockJiraConfig } from '../../../../helpers/factories.js';

const config = createMockJiraConfig();

describe('resolveStatusKeyByStatusId', () => {
	it('inverts the configured status mapping', () => {
		expect(resolveStatusKeyByStatusId(config, config.statusOptions.inProgress)).toBe('inProgress');
	});

	it('returns undefined for an unmapped status instead of guessing', () => {
		expect(resolveStatusKeyByStatusId(config, '99999')).toBeUndefined();
	});
});

describe('requireStatusIdForStatusKey', () => {
	it('returns a configured Jira status id', () => {
		expect(requireStatusIdForStatusKey(config, 'done')).toBe(config.statusOptions.done);
	});

	it('reports an unmapped canonical status as a configuration error', () => {
		expect(() => requireStatusIdForStatusKey(config, 'cancelled')).toThrow(/cancelled/);
	});
});
