import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger.js', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
	_resetRetiredOperatorTokenNotice,
	noticeRetiredOperatorTokens,
} from '@/config/retired-operator-tokens.js';
import { logger } from '@/lib/logger.js';

describe('noticeRetiredOperatorTokens (issue #1249)', () => {
	beforeEach(() => {
		_resetRetiredOperatorTokenNotice();
		vi.mocked(logger.info).mockClear();
		vi.mocked(logger.warn).mockClear();
	});

	it('says nothing on a host that sets none of the retired variables', () => {
		noticeRetiredOperatorTokens({ SWARM_OPERATOR_GH_TOKEN: '  ' });
		expect(logger.info).not.toHaveBeenCalled();
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('names every retired variable the host still sets, and says it is ignored', () => {
		noticeRetiredOperatorTokens({
			SWARM_OPERATOR_GH_TOKEN: 'ghp_secret',
			SWARM_OPERATOR_AZURE_DEVOPS_TOKEN: 'azure-secret',
		});

		expect(logger.info).toHaveBeenCalledOnce();
		const message = vi.mocked(logger.info).mock.calls[0]?.[0] ?? '';
		expect(message).toContain(
			'SWARM_OPERATOR_GH_TOKEN, SWARM_OPERATOR_AZURE_DEVOPS_TOKEN are set but ignored',
		);
		expect(message).not.toContain('SWARM_OPERATOR_GITLAB_TOKEN');
		// Presence only — the value never reaches the log.
		expect(message).not.toContain('ghp_secret');
		expect(message).not.toContain('azure-secret');
	});

	it('notices once per process', () => {
		const env = { SWARM_OPERATOR_BITBUCKET_TOKEN: 'user:app-password' };
		noticeRetiredOperatorTokens(env);
		noticeRetiredOperatorTokens(env);

		expect(logger.info).toHaveBeenCalledOnce();
		expect(vi.mocked(logger.info).mock.calls[0]?.[0]).toContain(
			'SWARM_OPERATOR_BITBUCKET_TOKEN is set but ignored',
		);
	});
});
