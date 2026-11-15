import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../src/db/client.js';
import {
	claimEpisodeReport,
	findStandingEpisodeCheckForHead,
	findStandingEpisodes,
	listRecentCheckFailureObservations,
	openEpisode,
	recordCheckFailureObservations,
} from '../../../src/db/repositories/sharedCheckFailuresRepository.js';
import {
	sharedCheckFailureEpisodes,
	sharedCheckFailureObservations,
} from '../../../src/db/schema/sharedCheckFailures.js';
import { truncateAll } from '../helpers/db.js';
import { seedProject } from '../helpers/seed.js';

const PROJECT_ID = 'proj-shared-check-failures';
const REPO = 'SmartTechBrewery/shared-check';
const HOUR = 60 * 60 * 1000;

const head = (prNumber: string, headSha: string) => ({
	projectId: PROJECT_ID,
	repository: REPO,
	prNumber,
	headSha,
});

const longAgo = () => new Date(Date.now() - 24 * HOUR);

// issue #1464 — what only Postgres can prove: the observation upsert is idempotent,
// the partial unique index allows one standing episode per check, an expired one is
// resolved and replaced, and the report claim is won once.
describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)('sharedCheckFailuresRepository', () => {
	beforeEach(async () => {
		await truncateAll();
		await seedProject({ id: PROJECT_ID, repo: REPO });
	});

	it('records one sighting per head and check however often it is seen', async () => {
		await recordCheckFailureObservations(head('10', 'h10'), ['Verify', 'lint']);
		await recordCheckFailureObservations(head('10', 'h10'), ['Verify']);
		await recordCheckFailureObservations(head('11', 'h11'), ['Verify']);

		expect(await getDb().select().from(sharedCheckFailureObservations)).toHaveLength(3);
		const recent = await listRecentCheckFailureObservations(
			PROJECT_ID,
			REPO,
			['Verify'],
			new Date(Date.now() - HOUR),
		);
		expect(recent.map((row) => row.prNumber).sort()).toEqual(['10', '11']);
		expect(
			await listRecentCheckFailureObservations(
				PROJECT_ID,
				REPO,
				['Verify'],
				new Date(Date.now() + HOUR),
			),
		).toEqual([]);
	});

	it('keeps one standing episode per check, and a second open answers it', async () => {
		const first = await openEpisode(PROJECT_ID, REPO, 'Verify', longAgo());
		const second = await openEpisode(PROJECT_ID, REPO, 'Verify', longAgo());

		expect(first.created).toBe(true);
		expect(second).toEqual({ episode: first.episode, created: false });
		expect(await getDb().select().from(sharedCheckFailureEpisodes)).toHaveLength(1);
		expect(
			(await findStandingEpisodes(PROJECT_ID, REPO, ['Verify', 'lint'], longAgo())).map(
				(row) => row.checkName,
			),
		).toEqual(['Verify']);
	});

	it('resolves an expired episode and opens its successor', async () => {
		const old = await openEpisode(PROJECT_ID, REPO, 'Verify', longAgo());
		// Everything opened up to now counts as expired.
		const next = await openEpisode(PROJECT_ID, REPO, 'Verify', new Date(Date.now() + 1000));

		expect(next.created).toBe(true);
		expect(next.episode.id).not.toBe(old.episode.id);
		const rows = await getDb().select().from(sharedCheckFailureEpisodes);
		const expired = rows.find((row) => row.id === old.episode.id);
		expect(expired?.resolution).toBe('expired');
		expect(expired?.resolvedAt).not.toBeNull();
		// An episode older than the bound no longer stands.
		expect(
			await findStandingEpisodes(PROJECT_ID, REPO, ['Verify'], new Date(Date.now() + 1000)),
		).toEqual([]);
	});

	it('lets one caller win the report claim', async () => {
		const { episode } = await openEpisode(PROJECT_ID, REPO, 'Verify', longAgo());
		const claims = await Promise.all([
			claimEpisodeReport(episode.id),
			claimEpisodeReport(episode.id),
		]);
		expect(claims.filter(Boolean)).toHaveLength(1);
	});

	it('finds the standing episode covering a sighted head, and only that head', async () => {
		await recordCheckFailureObservations(head('10', 'h10'), ['Verify']);
		expect(await findStandingEpisodeCheckForHead(head('10', 'h10'), longAgo())).toBeUndefined();

		await openEpisode(PROJECT_ID, REPO, 'Verify', longAgo());
		expect(await findStandingEpisodeCheckForHead(head('10', 'h10'), longAgo())).toBe('Verify');
		expect(await findStandingEpisodeCheckForHead(head('10', 'newer'), longAgo())).toBeUndefined();
		expect(await findStandingEpisodeCheckForHead(head('12', 'h12'), longAgo())).toBeUndefined();
	});
});
