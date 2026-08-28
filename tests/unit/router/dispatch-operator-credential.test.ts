import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/identity/worker-scm-credential.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/identity/worker-scm-credential.js')>()),
	requireWorkerScmCredential: vi.fn(),
}));

import { AgentRunError } from '@/harness/agent-failure.js';
import {
	MissingWorkerScmCredentialError,
	requireWorkerScmCredential,
} from '@/identity/worker-scm-credential.js';
import type { SCMProviderManifest } from '@/integrations/scm/manifest.js';
import {
	_resetSCMProviderRegistryForTesting,
	registerSCMProvider,
} from '@/integrations/scm/registry.js';
import { resolveOperatorCredential } from '@/router/dispatcher.js';
import type { DispatchSelection } from '@/worker/eligibility-gate.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

const SELECTION: DispatchSelection = {
	workerId: '11111111-1111-4111-8111-111111111111',
	workerName: 'm5_pro',
	ownerUserId: 'user-1',
	target: { cli: 'claude' },
	targetIndex: 0,
	cli: 'claude',
	skippedClis: [],
};

/** A manifest stand-in — the id is all this seam reads off it. */
function fakeManifest(id: string): SCMProviderManifest {
	return {
		id,
		label: id,
		category: 'scm',
		credentialRoles: [
			{ role: 'reviewer', envVarKey: `${id.toUpperCase()}_TOKEN_REVIEWER` },
			{ role: 'webhookSecret', envVarKey: `${id.toUpperCase()}_WEBHOOK_SECRET` },
		],
		provider: { id },
	} as unknown as SCMProviderManifest;
}

/**
 * The pre-push credential resolution every control-plane dispatch performs (issue
 * #765). Two things are worth pinning here and nowhere else: it asks for the
 * provider the *project* names rather than a hardcoded GitHub, and a worker with
 * nothing stored fails the dispatch attributably before anything is pushed.
 */
describe('resolveOperatorCredential', () => {
	beforeEach(() => {
		_resetSCMProviderRegistryForTesting();
		registerSCMProvider(fakeManifest('github'));
		registerSCMProvider(fakeManifest('bitbucket'));
		vi.mocked(requireWorkerScmCredential).mockReset();
	});

	it('resolves the selected worker credential for the provider the project targets', async () => {
		vi.mocked(requireWorkerScmCredential).mockResolvedValue('bb-app-password');
		const project = createMockProjectConfig({ id: 'bb-project', scm: 'bitbucket' });

		await expect(resolveOperatorCredential(project, SELECTION)).resolves.toBe('bb-app-password');
		// Not `project.scm ?? 'github'` — a Bitbucket project must not be handed the
		// GitHub credential.
		expect(requireWorkerScmCredential).toHaveBeenCalledWith({
			workerId: SELECTION.workerId,
			workerName: 'm5_pro',
			scmProviderId: 'bitbucket',
		});
	});

	it('fails the dispatch terminally, naming the worker and provider, when none is stored', async () => {
		vi.mocked(requireWorkerScmCredential).mockRejectedValue(
			new MissingWorkerScmCredentialError(
				SELECTION.workerId,
				'm5_pro',
				'github',
				"No operator SCM credential stored for worker 'm5_pro' (id w-1) on provider 'github'.",
			),
		);
		const project = createMockProjectConfig({ scm: 'github' });

		const error = await resolveOperatorCredential(project, SELECTION).catch((err: unknown) => err);
		// `'error'`, the one kind `handlePhaseFailure` treats as terminal — the other two
		// pre-push throws here (`aborted`, `DeliveryDeferredError`) are both deferrable,
		// and deferring an unset credential would retry until the budget ran out and bury
		// the message that says which worker and provider to fix.
		expect(error).toBeInstanceOf(AgentRunError);
		expect((error as AgentRunError).failure.kind).toBe('error');
		expect((error as AgentRunError).message).toContain("worker 'm5_pro'");
		expect((error as AgentRunError).message).toContain("provider 'github'");
	});

	it('surfaces an unresolvable SCM provider rather than picking one', async () => {
		_resetSCMProviderRegistryForTesting();
		registerSCMProvider(fakeManifest('github'));
		const project = createMockProjectConfig({ id: 'gl-project', scm: 'gitlab' });

		await expect(resolveOperatorCredential(project, SELECTION)).rejects.toThrow(
			/Cannot resolve the SCM provider for project 'gl-project'/,
		);
		expect(requireWorkerScmCredential).not.toHaveBeenCalled();
	});
});
