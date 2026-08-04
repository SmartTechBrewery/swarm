import { describe, expect, it } from 'vitest';
import { QUEUE_NAME, SwarmJobSchema } from '@/queue/jobs.js';
import {
	createMockGitHubProjectsWebhookJob,
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

	it('parses a github-projects webhook job', () => {
		const job = createMockGitHubProjectsWebhookJob();
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

	it('rejects an scm job carrying a projects_v2_item event', () => {
		const job = {
			...createMockScmWebhookJob(),
			event: createMockGitHubProjectsWebhookJob().event,
		};
		expect(() => SwarmJobSchema.parse(roundTrip(job))).toThrow();
	});

	it('rejects an event kind outside the neutral vocabulary', () => {
		const job = createMockScmWebhookJob();
		const tampered = { ...job, event: { ...job.event, kind: 'push' } };
		expect(() => SwarmJobSchema.parse(roundTrip(tampered))).toThrow();
	});

	it('rejects an scm job whose providerId is not a known provider', () => {
		const job = { ...createMockScmWebhookJob(), providerId: 'gitlab' };
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

		it('leaves a `github-projects` board row untouched — the PM envelope did not change', () => {
			const job = createMockGitHubProjectsWebhookJob();
			expect(SwarmJobSchema.parse(roundTrip(job))).toEqual(job);
		});

		it('rejects a legacy row whose event name was never processable', () => {
			expect(() => SwarmJobSchema.parse(roundTrip(legacyJob({ eventType: 'push' })))).toThrow();
		});
	});

	it('names the queue both sides speak on', () => {
		expect(QUEUE_NAME).toBe('swarm-jobs');
	});
});
