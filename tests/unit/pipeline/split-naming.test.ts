import { describe, expect, it } from 'vitest';

import { formatSplitTitle, parseSplitTitle, resolveSplitNaming } from '@/pipeline/split-naming.js';

describe('parseSplitTitle', () => {
	it('splits a shared-name-first title into its name and the phase-specific task', () => {
		expect(parseSplitTitle('Trello PM 3/6: Board writes and the dependency opt-out')).toEqual({
			sharedName: 'Trello PM',
			task: 'Board writes and the dependency opt-out',
		});
	});

	it('drops the generic phase-first prefix rather than adopting "Phase" as a name', () => {
		expect(parseSplitTitle('Phase 3/6: Trello board writes')).toEqual({
			task: 'Trello board writes',
		});
		expect(parseSplitTitle('3/6: Trello board writes')).toEqual({ task: 'Trello board writes' });
	});

	it('keeps an unmarked title whole, colons and slashes included', () => {
		expect(parseSplitTitle('Board writes')).toEqual({ task: 'Board writes' });
		expect(parseSplitTitle('fix: the retry/backoff policy')).toEqual({
			task: 'fix: the retry/backoff policy',
		});
		// The marker has to be the *whole* tail before the first colon.
		expect(parseSplitTitle('Rework 2 of 3 lists: the writes')).toEqual({
			task: 'Rework 2 of 3 lists: the writes',
		});
	});

	it('anchors on the first colon, so a task carrying its own colon survives', () => {
		expect(parseSplitTitle('Trello PM 2/4: Board writes: the idempotent half')).toEqual({
			sharedName: 'Trello PM',
			task: 'Board writes: the idempotent half',
		});
	});

	it('round-trips what the convention itself emits, so re-normalising never nests a prefix', () => {
		const title = formatSplitTitle('Trello PM', 2, 4, 'Board writes');
		expect(title).toBe('Trello PM 2/4: Board writes');
		const parsed = parseSplitTitle(title);
		expect(formatSplitTitle(parsed.sharedName as string, 2, 4, parsed.task)).toBe(title);
	});
});

describe('resolveSplitNaming', () => {
	it('titles the original and every child with the declared shared name and its phase', () => {
		const naming = resolveSplitNaming({
			declaredSharedName: 'Trello PM',
			parentTitle: 'Add a Trello PM provider',
			mainTaskTitle: 'Board reads',
			subTaskTitles: ['Board writes', 'The dependency opt-out'],
		});

		expect(naming).toEqual({
			sharedName: 'Trello PM',
			mainTaskTitle: 'Trello PM 1/3: Board reads',
			subTaskTitles: ['Trello PM 2/3: Board writes', 'Trello PM 3/3: The dependency opt-out'],
		});
	});

	it('rewrites phase-first titles the model may still emit', () => {
		const naming = resolveSplitNaming({
			declaredSharedName: 'Trello PM',
			parentTitle: 'Add a Trello PM provider',
			mainTaskTitle: 'Phase 1/3: Board reads',
			subTaskTitles: ['Phase 2/3: Board writes', 'Phase 3/3: The dependency opt-out'],
		});

		expect(naming.mainTaskTitle).toBe('Trello PM 1/3: Board reads');
		expect(naming.subTaskTitles).toEqual([
			'Trello PM 2/3: Board writes',
			'Trello PM 3/3: The dependency opt-out',
		]);
	});

	it('adopts a prefix the model put on its titles when it declared no shared name', () => {
		const naming = resolveSplitNaming({
			parentTitle: 'Add a Trello PM provider',
			mainTaskTitle: 'Phase 1/2: Board reads',
			subTaskTitles: ['Trello PM 2/2: Board writes'],
		});

		expect(naming.sharedName).toBe('Trello PM');
		expect(naming.mainTaskTitle).toBe('Trello PM 1/2: Board reads');
		expect(naming.subTaskTitles).toEqual(['Trello PM 2/2: Board writes']);
	});

	it('derives a name from the first task when the model supplied none at all', () => {
		const naming = resolveSplitNaming({
			parentTitle: 'Use shared task prefixes for scannable split Planning cards',
			subTaskTitles: ['Rename the cards already on the board'],
		});

		expect(naming.sharedName).toBe('Use shared task prefixes for scannable');
		expect(naming.mainTaskTitle).toBe(
			'Use shared task prefixes for scannable 1/2: Use shared task prefixes for scannable split Planning cards',
		);
		expect(naming.subTaskTitles).toEqual([
			'Use shared task prefixes for scannable 2/2: Rename the cards already on the board',
		]);
	});

	it('derives a different name for a different split with the same phase count', () => {
		const trello = resolveSplitNaming({
			parentTitle: 'Add a Trello PM provider',
			subTaskTitles: ['Board writes'],
		});
		const jira = resolveSplitNaming({
			parentTitle: 'Add a Jira PM provider',
			subTaskTitles: ['Board writes'],
		});

		expect(trello.sharedName).not.toBe(jira.sharedName);
	});

	it('strips a colon or a stray phase marker out of a declared name, so the format round-trips', () => {
		const naming = resolveSplitNaming({
			declaredSharedName: 'Trello PM 1/3:',
			parentTitle: 'Add a Trello PM provider',
			subTaskTitles: ['Board writes'],
		});

		expect(naming.sharedName).toBe('Trello PM');
		expect(naming.mainTaskTitle).toBe('Trello PM 1/2: Add a Trello PM provider');
	});

	it('numbers phases one-based over the original plus its children', () => {
		const naming = resolveSplitNaming({
			declaredSharedName: 'Recovery intent',
			parentTitle: 'Record the recovery intent',
			subTaskTitles: ['a', 'b', 'c', 'd', 'e'],
		});

		expect(naming.mainTaskTitle.startsWith('Recovery intent 1/6:')).toBe(true);
		expect(naming.subTaskTitles.map((title) => title.split(':')[0])).toEqual([
			'Recovery intent 2/6',
			'Recovery intent 3/6',
			'Recovery intent 4/6',
			'Recovery intent 5/6',
			'Recovery intent 6/6',
		]);
	});
});
