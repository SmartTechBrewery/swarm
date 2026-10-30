import { beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@/lib/logger.js';
import type { PMProvider, RepositoryClaim } from '@/pm/types.js';
import {
	surfaceUnroutedCard,
	unroutedCardCommentBody,
	unroutedCardMarker,
} from '@/pm/unrouted-card-notice.js';
import { isSwarmGeneratedBody } from '@/scm/swarm-origin.js';
import { createMockProjectConfig, createMockWorkItem } from '../../helpers/factories.js';

const PROJECT = createMockProjectConfig();
const ITEM_ID = 'VT-1538';
const REPOSITORIES = ['core3pl/KV-TMS/ai-sdlc', 'core3pl/KV-TMS/VikingKurier'];
const WRONG: RepositoryClaim = { source: 'Repozytorium', value: 'core3pl/KV-TMS/elsewhere' };
const EMPTY: RepositoryClaim = { source: 'Repozytorium', value: '' };

describe('unroutedCardCommentBody', () => {
	it('names the field, the value read, and every repository it could have been', () => {
		const body = unroutedCardCommentBody({
			phase: 'planning',
			claim: WRONG,
			repositories: REPOSITORIES,
		});

		expect(body).toContain('### SWARM could not start Planning');
		expect(body).toContain('**Repozytorium** field reads `core3pl/KV-TMS/elsewhere`');
		expect(body).toContain('- `core3pl/KV-TMS/ai-sdlc`');
		expect(body).toContain('- `core3pl/KV-TMS/VikingKurier`');
		expect(body).toContain('**Nothing was started.**');
		// Carries SWARM's own footer and marker, so it is recognised as SWARM's.
		expect(isSwarmGeneratedBody(body)).toBe(true);
		expect(body).toContain(
			unroutedCardMarker({ phase: 'planning', claim: WRONG, repositories: REPOSITORIES }),
		);
	});

	it('says the field is empty rather than quoting an empty value', () => {
		const body = unroutedCardCommentBody({
			phase: 'implementation',
			claim: EMPTY,
			repositories: REPOSITORIES,
		});

		expect(body).toContain('### SWARM could not start Implementation');
		expect(body).toContain('**Repozytorium** field is empty');
		expect(body).not.toContain('``');
	});
});

describe('unroutedCardMarker', () => {
	it('is stable per phase and value, and differs when either changes', () => {
		const notice = { phase: 'planning' as const, claim: WRONG, repositories: REPOSITORIES };
		expect(unroutedCardMarker(notice)).toBe(unroutedCardMarker({ ...notice }));
		expect(unroutedCardMarker({ ...notice, phase: 'implementation' })).not.toBe(
			unroutedCardMarker(notice),
		);
		expect(unroutedCardMarker({ ...notice, claim: EMPTY })).not.toBe(unroutedCardMarker(notice));
	});

	// The value is typed by a person, so it must not be able to close the hidden marker.
	it('does not embed the value it was read from', () => {
		const marker = unroutedCardMarker({
			phase: 'planning',
			claim: { source: 'Repozytorium', value: 'x --> visible' },
			repositories: REPOSITORIES,
		});
		expect(marker).toMatch(/^<!-- swarm-unrouted-card:planning:[0-9a-f]{16} -->$/);
	});
});

describe('surfaceUnroutedCard', () => {
	let provider: {
		getWorkItem: ReturnType<typeof vi.fn>;
		findComment: ReturnType<typeof vi.fn>;
		addComment: ReturnType<typeof vi.fn>;
	};

	/** A card in the fixture board's Planning column, opted into automation. */
	function cardIn(overrides: Parameters<typeof createMockWorkItem>[0] = {}) {
		return createMockWorkItem({ id: ITEM_ID, statusKey: 'planning', ...overrides });
	}

	function surface(project = PROJECT, claim = WRONG) {
		return surfaceUnroutedCard(
			provider as unknown as PMProvider,
			project,
			ITEM_ID,
			claim,
			REPOSITORIES,
		);
	}

	beforeEach(() => {
		provider = {
			getWorkItem: vi.fn().mockResolvedValue(cardIn()),
			findComment: vi.fn().mockResolvedValue(undefined),
			addComment: vi.fn().mockResolvedValue('comment-1'),
		};
	});

	it('posts the notice on an opted-in card that entered a phase-starting column', async () => {
		await surface();

		expect(provider.addComment).toHaveBeenCalledWith(
			ITEM_ID,
			unroutedCardCommentBody({ phase: 'planning', claim: WRONG, repositories: REPOSITORIES }),
		);
	});

	it('posts nothing when the same notice is already on the card', async () => {
		provider.findComment.mockResolvedValue('comment-0');

		await surface();

		expect(provider.findComment).toHaveBeenCalledWith(
			ITEM_ID,
			unroutedCardMarker({ phase: 'planning', claim: WRONG, repositories: REPOSITORIES }),
		);
		expect(provider.addComment).not.toHaveBeenCalled();
	});

	it.each([
		['starts no phase', { statusKey: 'done' }],
		['maps to no canonical status', { statusKey: undefined }],
	])('posts nothing for a card whose column %s', async (_label, overrides) => {
		provider.getWorkItem.mockResolvedValue(cardIn(overrides));

		await surface();

		expect(provider.findComment).not.toHaveBeenCalled();
		expect(provider.addComment).not.toHaveBeenCalled();
	});

	it('posts nothing on a card without the automation label', async () => {
		provider.getWorkItem.mockResolvedValue(cardIn({ labels: [] }));

		await surface();

		expect(provider.addComment).not.toHaveBeenCalled();
	});

	it('posts on an unlabelled card when the automation gate is switched off', async () => {
		provider.getWorkItem.mockResolvedValue(cardIn({ labels: [] }));

		await surface(createMockProjectConfig({ pipeline: { automationLabel: '' } }));

		expect(provider.addComment).toHaveBeenCalledOnce();
	});

	// The refusal stands either way: a failed notice must never surface as a throw.
	it('logs and swallows a provider failure', async () => {
		const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
		provider.addComment.mockRejectedValue(new Error('Jira unavailable'));

		await expect(surface()).resolves.toBeUndefined();

		expect(warnSpy).toHaveBeenCalledWith(
			'Could not post the unrouted-card notice',
			expect.objectContaining({ itemId: ITEM_ID, error: 'Jira unavailable' }),
		);
		warnSpy.mockRestore();
	});
});
