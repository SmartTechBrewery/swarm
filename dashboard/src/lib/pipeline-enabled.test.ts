import { describe, expect, it } from 'vitest';
import type { PipelineConfig } from '../../../src/config/schema.js';
import {
	autoAdvanceConfigPhase,
	autoAdvanceSummary,
	buildPipelineAutoAdvanceUpdate,
	buildPipelineEnabledUpdate,
	buildPipelineToggleUpdate,
	buildReviewChecksPolicyUpdate,
	buildVerifyPlanUpdate,
	isAutoAdvancePhase,
	isPipelineAutoAdvanceDirty,
	isPipelineEnabledDirty,
	isRespondToReviewLocked,
	isReviewChecksPolicyDirty,
	isVerifyPlanDirty,
	setAutoAdvanceEnabled,
	setPhaseEnabled,
	toPipelineAutoAdvanceForm,
	toPipelineEnabledForm,
	toReviewChecksPolicyForm,
	toVerifyPlanForm,
} from './pipeline-enabled.js';

describe('auto-advance form mapping', () => {
	it('uses the coded Planning-off default', () => {
		expect(toPipelineAutoAdvanceForm(undefined)).toEqual({ planning: false });
	});

	it('reads explicit values and reports only changed values as dirty', () => {
		const pipeline: PipelineConfig = {
			planning: { autoAdvance: true },
		};
		const form = toPipelineAutoAdvanceForm(pipeline);
		expect(form).toEqual({ planning: true });
		expect(isPipelineAutoAdvanceDirty(form, pipeline)).toBe(false);
		expect(isPipelineAutoAdvanceDirty({ ...form, planning: false }, pipeline)).toBe(true);
	});

	it('updates only auto-advance while preserving unrelated pipeline settings', () => {
		const existing: PipelineConfig = {
			planning: { autoAdvance: true, autoSplit: false },
			review: { enabled: false },
			respondToReview: { enabled: false, autoMerge: true, skipOnMinors: false },
			respondToCi: { enabled: false },
		};
		expect(buildPipelineAutoAdvanceUpdate({ planning: false }, existing)).toEqual({
			...existing,
			planning: { autoAdvance: false, autoSplit: false },
		});
	});

	it('combines auto-advance and enabled edits without dropping other settings', () => {
		const existing: PipelineConfig = {
			planning: { autoSplit: false },
			review: {},
			respondToReview: { autoMerge: true, skipOnMinors: false },
			respondToCi: {},
		};
		const enabled = buildPipelineEnabledUpdate(
			{ review: false, respondToReview: true, respondToCi: false },
			existing,
		);

		expect(buildPipelineAutoAdvanceUpdate({ planning: true }, enabled)).toEqual({
			planning: { autoAdvance: true, autoSplit: false },
			review: { enabled: false },
			respondToReview: { enabled: false, autoMerge: true, skipOnMinors: false },
			respondToCi: { enabled: false },
		});
	});
});

describe('verify-plan form mapping', () => {
	it('reads an unset override as off', () => {
		expect(toVerifyPlanForm(undefined)).toBe(false);
		expect(toVerifyPlanForm({})).toBe(false);
		expect(toVerifyPlanForm({ planning: { autoAdvance: true } })).toBe(false);
	});

	it('reads the stored value and reports only a differing selection as dirty', () => {
		const pipeline: PipelineConfig = { planning: { verifyPlan: true } };
		expect(toVerifyPlanForm(pipeline)).toBe(true);
		expect(isVerifyPlanDirty(true, pipeline)).toBe(false);
		expect(isVerifyPlanDirty(false, pipeline)).toBe(true);
		// An unset override reads as off, so selecting "on" against it is dirty.
		expect(isVerifyPlanDirty(true, undefined)).toBe(true);
		expect(isVerifyPlanDirty(false, undefined)).toBe(false);
	});

	it('updates only verifyPlan while preserving unrelated pipeline settings', () => {
		const existing: PipelineConfig = {
			planning: { autoAdvance: true, autoSplit: false, maxConcerns: 3 },
			review: { enabled: false },
			respondToReview: { enabled: false, autoMerge: true, skipOnMinors: false },
			respondToCi: { enabled: false },
		};
		expect(buildVerifyPlanUpdate(true, existing)).toEqual({
			...existing,
			planning: { autoAdvance: true, autoSplit: false, maxConcerns: 3, verifyPlan: true },
		});
	});

	it('writes the flag onto a project with no stored pipeline at all', () => {
		expect(buildVerifyPlanUpdate(true, undefined)).toEqual({ planning: { verifyPlan: true } });
	});
});

describe('toPipelineEnabledForm', () => {
	it('defaults every phase to enabled when config is undefined', () => {
		expect(toPipelineEnabledForm(undefined)).toEqual({
			review: true,
			respondToReview: true,
			respondToCi: true,
		});
	});

	it('treats an unset enabled flag as enabled', () => {
		const pipeline: PipelineConfig = { review: {}, respondToReview: { autoMerge: true } };
		expect(toPipelineEnabledForm(pipeline)).toEqual({
			review: true,
			respondToReview: true,
			respondToCi: true,
		});
	});

	it('reflects an explicit false as disabled', () => {
		const pipeline: PipelineConfig = {
			review: { enabled: false },
			respondToReview: { enabled: false },
			respondToCi: { enabled: false },
		};
		expect(toPipelineEnabledForm(pipeline)).toEqual({
			review: false,
			respondToReview: false,
			respondToCi: false,
		});
	});
});

describe('setPhaseEnabled', () => {
	const allOn = { review: true, respondToReview: true, respondToCi: true };

	it('toggles the named phase without touching the others', () => {
		expect(setPhaseEnabled(allOn, 'respondToCi', false)).toEqual({
			review: true,
			respondToReview: true,
			respondToCi: false,
		});
	});

	it('forces respond-to-review off when review is turned off', () => {
		expect(setPhaseEnabled(allOn, 'review', false)).toEqual({
			review: false,
			respondToReview: false,
			respondToCi: true,
		});
	});

	it('leaves respond-to-review untouched when review is turned on', () => {
		const reviewOff = { review: false, respondToReview: false, respondToCi: true };
		expect(setPhaseEnabled(reviewOff, 'review', true)).toEqual({
			review: true,
			respondToReview: false,
			respondToCi: true,
		});
	});

	it('does not mutate the input form', () => {
		const input = { ...allOn };
		setPhaseEnabled(input, 'review', false);
		expect(input).toEqual(allOn);
	});
});

describe('isRespondToReviewLocked', () => {
	it('locks respond-to-review when review is off', () => {
		expect(
			isRespondToReviewLocked({ review: false, respondToReview: false, respondToCi: true }),
		).toBe(true);
	});

	it('unlocks respond-to-review when review is on', () => {
		expect(
			isRespondToReviewLocked({ review: true, respondToReview: true, respondToCi: true }),
		).toBe(false);
	});
});

describe('buildPipelineEnabledUpdate', () => {
	it('writes explicit enabled flags for all three phases', () => {
		const result = buildPipelineEnabledUpdate(
			{ review: true, respondToReview: false, respondToCi: true },
			undefined,
		);
		expect(result.review?.enabled).toBe(true);
		expect(result.respondToReview?.enabled).toBe(false);
		expect(result.respondToCi?.enabled).toBe(true);
	});

	it('preserves existing pipeline fields the screen does not edit', () => {
		const existing: PipelineConfig = {
			planning: { autoAdvance: true, autoSplit: false },
			respondToReview: { autoMerge: true, skipOnMinors: false },
		};
		const result = buildPipelineEnabledUpdate(
			{ review: true, respondToReview: true, respondToCi: true },
			existing,
		);
		expect(result.planning).toEqual({ autoAdvance: true, autoSplit: false });
		expect(result.respondToReview?.autoMerge).toBe(true);
		expect(result.respondToReview?.skipOnMinors).toBe(false);
		expect(result.respondToReview?.enabled).toBe(true);
	});

	it('forces respond-to-review off when review is off (satisfies the server refinement)', () => {
		const result = buildPipelineEnabledUpdate(
			{ review: false, respondToReview: true, respondToCi: true },
			{ respondToReview: { autoMerge: true } },
		);
		expect(result.review?.enabled).toBe(false);
		expect(result.respondToReview?.enabled).toBe(false);
		// The unrelated field still survives.
		expect(result.respondToReview?.autoMerge).toBe(true);
	});
});

describe('buildPipelineToggleUpdate', () => {
	it('carries the enabled flags, Planning auto-advance and Verify plan in one payload', () => {
		const result = buildPipelineToggleUpdate(
			{ review: true, respondToReview: false, respondToCi: true },
			{ planning: true },
			true,
			undefined,
		);
		expect(result.review?.enabled).toBe(true);
		expect(result.respondToReview?.enabled).toBe(false);
		expect(result.respondToCi?.enabled).toBe(true);
		expect(result.planning?.autoAdvance).toBe(true);
		expect(result.planning?.verifyPlan).toBe(true);
	});

	it('preserves every stored pipeline field the Agents-tab toggles do not own', () => {
		// The scoped toggle save must not drop Pipeline-tab settings (issue #369): a
		// project's autoMerge/skipOnMinors and Review check policy have to survive.
		const existing: PipelineConfig = {
			planning: { autoAdvance: false, autoSplit: true },
			review: { checks: 'if-present' },
			respondToReview: { autoMerge: true, skipOnMinors: false },
		};
		const result = buildPipelineToggleUpdate(
			{ review: true, respondToReview: true, respondToCi: true },
			{ planning: true },
			false,
			existing,
		);
		expect(result.planning).toEqual({ autoAdvance: true, autoSplit: true, verifyPlan: false });
		expect(result.review?.checks).toBe('if-present');
		expect(result.review?.enabled).toBe(true);
		expect(result.respondToReview?.autoMerge).toBe(true);
		expect(result.respondToReview?.skipOnMinors).toBe(false);
	});

	it('applies the Review→Respond dependency (respond forced off while review is off)', () => {
		const result = buildPipelineToggleUpdate(
			{ review: false, respondToReview: true, respondToCi: true },
			{ planning: false },
			false,
			undefined,
		);
		expect(result.review?.enabled).toBe(false);
		expect(result.respondToReview?.enabled).toBe(false);
	});
});

describe('isPipelineEnabledDirty', () => {
	it('is clean when the form matches the stored config', () => {
		const pipeline: PipelineConfig = {
			review: { enabled: false },
			respondToReview: { enabled: false },
		};
		expect(isPipelineEnabledDirty(toPipelineEnabledForm(pipeline), pipeline)).toBe(false);
	});

	it('is clean against undefined config when everything is on', () => {
		expect(
			isPipelineEnabledDirty({ review: true, respondToReview: true, respondToCi: true }, undefined),
		).toBe(false);
	});

	it('is dirty when a phase differs from the stored config', () => {
		expect(
			isPipelineEnabledDirty(
				{ review: true, respondToReview: true, respondToCi: false },
				undefined,
			),
		).toBe(true);
	});
});

describe('setAutoAdvanceEnabled', () => {
	it('sets the auto-advance value for a phase without mutating the input', () => {
		const form = { planning: false };
		const result = setAutoAdvanceEnabled(form, 'planning', true);
		expect(result).toEqual({ planning: true });
		expect(form).toEqual({ planning: false });
	});
});

describe('isAutoAdvancePhase', () => {
	it('identifies only Planning as an auto-advance phase', () => {
		expect(isAutoAdvancePhase('planning')).toBe(true);
		expect(isAutoAdvancePhase('implementation')).toBe(false);
	});

	it('rejects other phases', () => {
		expect(isAutoAdvancePhase('review')).toBe(false);
		expect(isAutoAdvancePhase('respondToReview')).toBe(false);
		expect(isAutoAdvancePhase('respondToCi')).toBe(false);
		expect(isAutoAdvancePhase('resolveConflicts')).toBe(false);
	});
});

describe('autoAdvanceConfigPhase', () => {
	it('returns the stored phase for supported phases and nothing for others', () => {
		expect(autoAdvanceConfigPhase('planning')).toBe('planning');
		expect(autoAdvanceConfigPhase('implementation')).toBeUndefined();
		expect(autoAdvanceConfigPhase('implementationUnplanned')).toBeUndefined();
		expect(autoAdvanceConfigPhase('review')).toBeUndefined();
	});
});

describe('toReviewChecksPolicyForm', () => {
	it('defaults to required when the pipeline is undefined', () => {
		expect(toReviewChecksPolicyForm(undefined)).toBe('required');
	});

	it('defaults to required when review.checks is unset', () => {
		expect(toReviewChecksPolicyForm({ review: { enabled: true } })).toBe('required');
	});

	it('reads a stored if-present value', () => {
		expect(toReviewChecksPolicyForm({ review: { checks: 'if-present' } })).toBe('if-present');
	});
});

describe('isReviewChecksPolicyDirty', () => {
	it('is clean when the selection matches the effective stored value', () => {
		expect(isReviewChecksPolicyDirty('required', undefined)).toBe(false);
		expect(isReviewChecksPolicyDirty('if-present', { review: { checks: 'if-present' } })).toBe(
			false,
		);
	});

	it('is dirty when the selection differs from the effective stored value', () => {
		expect(isReviewChecksPolicyDirty('if-present', undefined)).toBe(true);
		expect(isReviewChecksPolicyDirty('required', { review: { checks: 'if-present' } })).toBe(true);
	});
});

describe('buildReviewChecksPolicyUpdate', () => {
	it('sets the policy when no pipeline config exists yet', () => {
		expect(buildReviewChecksPolicyUpdate('if-present', undefined)).toEqual({
			review: { checks: 'if-present' },
		});
	});

	it('preserves unrelated pipeline fields and the existing review.enabled flag', () => {
		const existing: PipelineConfig = {
			planning: { autoAdvance: true },
			review: { enabled: false },
			respondToReview: { enabled: false, autoMerge: true, skipOnMinors: false },
			respondToCi: { enabled: true },
		};
		expect(buildReviewChecksPolicyUpdate('if-present', existing)).toEqual({
			...existing,
			review: { enabled: false, checks: 'if-present' },
		});
	});
});

describe('autoAdvanceSummary', () => {
	it('returns N/A when enabled is undefined', () => {
		expect(autoAdvanceSummary('planning', undefined)).toBe('N/A');
		expect(autoAdvanceSummary('implementation', undefined)).toBe('N/A');
	});

	it('returns planning summary for true/false', () => {
		expect(autoAdvanceSummary('planning', true)).toBe('On — moves to ToDo after posting the plan');
		expect(autoAdvanceSummary('planning', false)).toBe('Off — stays in Planning');
	});

	it('returns N/A for Implementation', () => {
		expect(autoAdvanceSummary('implementation', true)).toBe('N/A');
		expect(autoAdvanceSummary('implementation', false)).toBe('N/A');
	});
});
