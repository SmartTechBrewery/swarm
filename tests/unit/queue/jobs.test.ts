import { describe, expect, it } from 'vitest';
import { QUEUE_NAME, repositoryForJob, SwarmJobSchema } from '@/queue/jobs.js';
import {
	createMockPmWebhookJob,
	createMockScmEvent,
	createMockScmWebhookJob,
} from '../../helpers/factories.js';

// Jobs cross the router→Redis→worker boundary as JSON, so every case parses a
// JSON round-trip of the fixture — what the consumer actually receives.
function roundTrip(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
}

describe('SwarmJobSchema', () => {
	it('parses an scm webhook job', () => {
		const job = createMockScmWebhookJob();
		expect(SwarmJobSchema.parse(roundTrip(job))).toEqual(job);
	});

	it('parses a pm webhook job', () => {
		const job = createMockPmWebhookJob();
		expect(SwarmJobSchema.parse(roundTrip(job))).toEqual(job);
	});

	it('parses a job without the optional deliveryId', () => {
		const { deliveryId: _dropped, ...job } = createMockScmWebhookJob();
		const parsed = SwarmJobSchema.parse(roundTrip(job));
		expect(parsed.deliveryId).toBeUndefined();
	});

	it('parses a job carrying a recheckAttempt count', () => {
		const job = { ...createMockScmWebhookJob(), recheckAttempt: 3 };
		expect(SwarmJobSchema.parse(roundTrip(job))).toMatchObject({ recheckAttempt: 3 });
	});

	it('rejects a negative recheckAttempt', () => {
		const job = { ...createMockScmWebhookJob(), recheckAttempt: -1 };
		expect(() => SwarmJobSchema.parse(roundTrip(job))).toThrow();
	});

	it('parses a job carrying a rateLimitRetryAttempt count', () => {
		const job = { ...createMockScmWebhookJob(), rateLimitRetryAttempt: 4 };
		expect(SwarmJobSchema.parse(roundTrip(job))).toMatchObject({ rateLimitRetryAttempt: 4 });
	});

	it('rejects a negative rateLimitRetryAttempt', () => {
		const job = { ...createMockScmWebhookJob(), rateLimitRetryAttempt: -1 };
		expect(() => SwarmJobSchema.parse(roundTrip(job))).toThrow();
	});

	it('parses a merge-automation job (issue #292)', () => {
		const job = {
			type: 'merge-automation',
			projectId: 'swarm',
			reviewRunId: 'run-1',
			repo: 'SmartTechBrewery/swarm',
			prNumber: '17',
			approvedHeadSha: 'deadbeef',
		};
		expect(SwarmJobSchema.parse(roundTrip(job))).toEqual(job);
	});

	it('rejects a merge-automation job missing its approved head SHA', () => {
		const job = {
			type: 'merge-automation',
			projectId: 'swarm',
			reviewRunId: 'run-1',
			repo: 'SmartTechBrewery/swarm',
			prNumber: '17',
		};
		expect(() => SwarmJobSchema.parse(roundTrip(job))).toThrow();
	});

	it('rejects an unknown job type', () => {
		const job = { ...createMockScmWebhookJob(), type: 'gitlab' };
		expect(() => SwarmJobSchema.parse(roundTrip(job))).toThrow();
	});

	it('rejects an empty projectId', () => {
		const job = { ...createMockScmWebhookJob(), projectId: '' };
		expect(() => SwarmJobSchema.parse(roundTrip(job))).toThrow();
	});

	it('rejects an scm job carrying a PM board event', () => {
		const job = {
			...createMockScmWebhookJob(),
			event: createMockPmWebhookJob().event,
		};
		expect(() => SwarmJobSchema.parse(roundTrip(job))).toThrow();
	});

	it('rejects an event kind outside the neutral vocabulary', () => {
		const job = createMockScmWebhookJob();
		const tampered = { ...job, event: { ...job.event, kind: 'push' } };
		expect(() => SwarmJobSchema.parse(roundTrip(tampered))).toThrow();
	});

	it('rejects an scm job whose providerId is not a known provider', () => {
		// Not `gitlab`: that became a known id when the provider's foundation landed
		// (issue #295), even though nothing registers it yet.
		const job = { ...createMockScmWebhookJob(), providerId: 'gitea' };
		expect(() => SwarmJobSchema.parse(roundTrip(job))).toThrow();
	});

	// A dependency recheck can wait days and a run's stored payload is re-parsed by
	// "Retry now" indefinitely, so a deploy must read rows written before issue #385
	// rather than fail their in-flight work.
	describe('legacy durable envelope (pre-#385)', () => {
		/** A dispatch row as the router wrote it when `type` *was* the provider id. */
		function legacyJob(event: Record<string, unknown>) {
			return {
				type: 'github',
				projectId: 'swarm',
				deliveryId: 'delivery-uuid-1',
				event: { repoFullName: 'SmartTechBrewery/swarm', isCommentEvent: false, ...event },
			};
		}

		it('upgrades the legacy discriminator to an scm job carrying its provider id', () => {
			const parsed = SwarmJobSchema.parse(
				roundTrip(legacyJob({ eventType: 'pull_request', action: 'opened', workItemId: '17' })),
			);
			expect(parsed).toMatchObject({ type: 'scm', providerId: 'github', projectId: 'swarm' });
		});

		it.each([
			['pull_request', 'pull-request'],
			['pull_request_review', 'pull-request-review'],
			['issues', 'work-item'],
			['issue_comment', 'work-item-comment'],
			['check_suite', 'checks'],
		])('maps the legacy %s event name to %s', (eventType, kind) => {
			const parsed = SwarmJobSchema.parse(roundTrip(legacyJob({ eventType })));
			expect(parsed).toMatchObject({ type: 'scm', event: { kind } });
		});

		it("maps GitHub's legacy `synchronize` action and `changes_requested` review state", () => {
			const parsed = SwarmJobSchema.parse(
				roundTrip(legacyJob({ eventType: 'pull_request', action: 'synchronize' })),
			);
			expect(parsed).toMatchObject({ event: { action: 'updated' } });

			const review = SwarmJobSchema.parse(
				roundTrip(
					legacyJob({
						eventType: 'pull_request_review',
						action: 'submitted',
						reviewState: 'changes_requested',
					}),
				),
			);
			expect(review).toMatchObject({ event: { reviewState: 'changes-requested' } });
		});

		it('preserves the retry/recheck counters a waiting legacy row was deferred with', () => {
			const parsed = SwarmJobSchema.parse(
				roundTrip({
					...legacyJob({ eventType: 'check_suite', action: 'completed', headSha: 'cafe' }),
					recheckAttempt: 3,
					dependencyRecheckAttempt: 2,
					runId: 'run-1',
				}),
			);
			expect(parsed).toMatchObject({
				type: 'scm',
				recheckAttempt: 3,
				dependencyRecheckAttempt: 2,
				runId: 'run-1',
				event: { kind: 'checks', action: 'completed', headSha: 'cafe' },
			});
		});

		it('rejects a legacy row whose event name was never processable', () => {
			expect(() => SwarmJobSchema.parse(roundTrip(legacyJob({ eventType: 'push' })))).toThrow();
		});
	});

	// The PM side got the same treatment in issue #297: `type` *was* the provider id
	// (`github-projects`) and the event *was* GitHub's own webhook vocabulary. Live
	// dispatch rows and `runs.jobPayload` snapshots written before that deploy must
	// still parse — this is the acceptance criterion for the migration.
	describe('legacy durable envelope (pre-#297, PM)', () => {
		/** A dispatch row as the router wrote a board event before the PM migration. */
		const LEGACY_BOARD_ROW = {
			type: 'github-projects',
			projectId: 'swarm',
			deliveryId: 'delivery-uuid-2',
			event: {
				eventType: 'projects_v2_item',
				action: 'edited',
				itemNodeId: 'PVTI_lAHOAC3TF84BcNwDzgxczms',
				projectNodeId: 'PVT_kwHOAC3TF84BcNwD',
				contentNodeId: 'I_kwDONODE',
				contentType: 'Issue',
				changedFieldNodeId: 'PVTSSF_lAHOAC3TF84BcNwDzhW4MKo',
				changedFieldType: 'single_select',
				actorLogin: 'human-dev',
			},
		};

		it('upgrades the envelope and every event field to the neutral encoding', () => {
			expect(SwarmJobSchema.parse(roundTrip(LEGACY_BOARD_ROW))).toEqual({
				type: 'pm',
				providerId: 'github-projects',
				projectId: 'swarm',
				deliveryId: 'delivery-uuid-2',
				event: {
					action: 'updated',
					itemId: 'PVTI_lAHOAC3TF84BcNwDzgxczms',
					containerId: 'PVT_kwHOAC3TF84BcNwD',
					contentId: 'I_kwDONODE',
					contentType: 'Issue',
					changedField: 'PVTSSF_lAHOAC3TF84BcNwDzhW4MKo',
					changedFieldType: 'single_select',
					actorHandle: 'human-dev',
				},
			});
		});

		it.each([
			['edited', 'updated'],
			['reordered', 'moved'],
			['created', 'created'],
			['deleted', 'deleted'],
			// Outside the neutral vocabulary — rides through verbatim and matches no
			// trigger, exactly as before.
			['archived', 'archived'],
		])('remaps the legacy %s action to %s', (legacy, neutral) => {
			const parsed = SwarmJobSchema.parse(
				roundTrip({ ...LEGACY_BOARD_ROW, event: { ...LEGACY_BOARD_ROW.event, action: legacy } }),
			);
			expect(parsed).toMatchObject({ type: 'pm', event: { action: neutral } });
		});

		it('preserves the retry/recheck counters a waiting legacy board row was deferred with', () => {
			const parsed = SwarmJobSchema.parse(
				roundTrip({
					...LEGACY_BOARD_ROW,
					resumePmPhase: 'implementation',
					rateLimitRetryAttempt: 2,
					runId: 'run-1',
				}),
			);
			expect(parsed).toMatchObject({
				type: 'pm',
				providerId: 'github-projects',
				resumePmPhase: 'implementation',
				rateLimitRetryAttempt: 2,
				runId: 'run-1',
			});
		});

		it('leaves an already-neutral board event untouched', () => {
			const job = createMockPmWebhookJob();
			expect(SwarmJobSchema.parse(roundTrip(job))).toEqual(job);
		});

		it('rejects a pm job whose providerId is not a known provider', () => {
			const job = { ...createMockPmWebhookJob(), providerId: 'asana' };
			expect(() => SwarmJobSchema.parse(roundTrip(job))).toThrow();
		});
	});

	it('names the queue both sides speak on', () => {
		expect(QUEUE_NAME).toBe('swarm-jobs');
	});
});

// issue #684 phase 2 — the one place a job says which of its project's repositories
// it belongs to. Every variant answers from what it already carries, so a dispatch
// row written before this existed answers identically.
describe('repositoryForJob', () => {
	it('answers an scm job with the event repository its ingress recorded', () => {
		const job = createMockScmWebhookJob({
			event: createMockScmEvent({ repoFullName: 'acme/second' }),
		});
		expect(repositoryForJob(job)).toBe('acme/second');
	});

	it('answers a merge-automation job with the repository the intent was recorded for', () => {
		const job = SwarmJobSchema.parse({
			type: 'merge-automation',
			projectId: 'swarm',
			reviewRunId: 'run-1',
			repo: 'acme/second',
			prNumber: '17',
			approvedHeadSha: 'deadbeef',
		});
		expect(repositoryForJob(job)).toBe('acme/second');
	});

	// A board card names no repository, so board-driven Planning and Implementation
	// run against the project's default entry — unchanged behaviour.
	it('answers a pm job with undefined, so it scopes to the default entry', () => {
		expect(repositoryForJob(createMockPmWebhookJob())).toBeUndefined();
	});

	// The legacy envelope upgrades before the discriminator is read, so a dispatch row
	// written pre-#385 still resolves its repository rather than falling to the default.
	it('answers a legacy `github` envelope from its upgraded event', () => {
		const job = SwarmJobSchema.parse({
			type: 'github',
			projectId: 'swarm',
			deliveryId: 'legacy-1',
			event: {
				kind: 'pull-request',
				action: 'opened',
				repoFullName: 'acme/legacy',
				isCommentEvent: false,
			},
		});
		expect(repositoryForJob(job)).toBe('acme/legacy');
	});
});
