import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../src/db/client.js';
import {
	claimEpisodeReport,
	findStandingEpisodeCheckForHead,
	findStandingEpisodes,
	listEpisodeAffectedHeads,
	listRecentCheckFailureObservations,
	listStandingEpisodesForRepository,
	openEpisode,
	recordCheckFailureObservations,
	resolveEpisode,
	stampEpisodeBaseHead,
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

	// issue #1471 — the base-branch-health sweep's half.
	it('stamps the base head once and lists it with the standing episode', async () => {
		const { episode } = await openEpisode(PROJECT_ID, REPO, 'Verify', longAgo());
		expect(await listStandingEpisodesForRepository(PROJECT_ID, REPO, longAgo())).toEqual([
			{ ...episode, baseHeadSha: null },
		]);

		expect(await stampEpisodeBaseHead(episode.id, 'base-1')).toBe(true);
		// A later stamp never moves the reference a resume is judged by.
		expect(await stampEpisodeBaseHead(episode.id, 'base-2')).toBe(false);
		const [listed] = await listStandingEpisodesForRepository(PROJECT_ID, REPO, longAgo());
		expect(listed?.baseHeadSha).toBe('base-1');
		expect(await listStandingEpisodesForRepository(PROJECT_ID, 'Other/repo', longAgo())).toEqual(
			[],
		);
	});

	it('resolves an episode base-advanced for exactly one caller', async () => {
		const { episode } = await openEpisode(PROJECT_ID, REPO, 'Verify', longAgo());
		const wins = await Promise.all([
			resolveEpisode(episode.id, 'base-advanced'),
			resolveEpisode(episode.id, 'base-advanced'),
		]);

		expect(wins.filter(Boolean)).toHaveLength(1);
		const [row] = await getDb().select().from(sharedCheckFailureEpisodes);
		expect(row?.resolution).toBe('base-advanced');
		expect(row?.resolvedAt).not.toBeNull();
		expect(await listStandingEpisodesForRepository(PROJECT_ID, REPO, longAgo())).toEqual([]);
		expect(await stampEpisodeBaseHead(episode.id, 'base-1')).toBe(false);
		// The check is free to open a fresh episode, judged per head again.
		expect((await openEpisode(PROJECT_ID, REPO, 'Verify', longAgo())).created).toBe(true);
	});

	it("lists each pull request's latest sighted head of the episode's check", async () => {
		await recordCheckFailureObservations(head('10', 'old'), ['Verify']);
		await getDb()
			.update(sharedCheckFailureObservations)
			.set({ observedAt: new Date(Date.now() - HOUR) });
		await recordCheckFailureObservations(head('10', 'h10'), ['Verify']);
		await recordCheckFailureObservations(head('11', 'h11'), ['Verify', 'lint']);
		await recordCheckFailureObservations(head('12', 'h12'), ['lint']);

		const heads = await listEpisodeAffectedHeads(PROJECT_ID, REPO, 'Verify', longAgo());
		expect(heads.sort((a, b) => a.prNumber.localeCompare(b.prNumber))).toEqual([
			{ prNumber: '10', headSha: 'h10' },
			{ prNumber: '11', headSha: 'h11' },
		]);
		expect(
			await listEpisodeAffectedHeads(PROJECT_ID, REPO, 'Verify', new Date(Date.now() + HOUR)),
		).toEqual([]);
	});
});
