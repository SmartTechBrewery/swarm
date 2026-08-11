import { z } from 'zod';
import { AgentCliSchema } from './agent-cli.js';

export const QuotaWindowSchema = z.object({
	name: z.string(),
	durationMins: z.number().optional(),
	usedPercent: z.number().optional(),
	resetsAt: z.string().optional(), // ISO timestamp
});

export const CliQuotaSnapshotSchema = z.object({
	cli: AgentCliSchema,
	status: z.enum(['available', 'unavailable', 'error']),
	remainingPercentage: z.number().min(0).max(100).optional(),
	resetTime: z.string().optional(), // ISO timestamp or descriptive string
	plan: z.string().optional(), // e.g. "plus", "free", "pro"
	credits: z.string().optional(), // e.g. "available: 1", "balance: 0"
	source: z.enum(['live', 'fallback']),
	error: z.string().optional(),
	lastUpdated: z.string(), // ISO timestamp
	windows: z.array(QuotaWindowSchema).optional(),
});

export type QuotaWindow = z.infer<typeof QuotaWindowSchema>;
export type CliQuotaSnapshot = z.infer<typeof CliQuotaSnapshotSchema>;

/** Neutral name for a window whose provider reported no usable duration. */
export const UNKNOWN_QUOTA_WINDOW_NAME = 'Usage limit';

/**
 * Name a quota window after the duration the provider actually reported, never
 * after the slot it arrived in (issue #669). Codex dropped its hourly session
 * limit and now returns a *weekly* window in the `primary` slot, so a hardcoded
 * "Primary (5-hour)" contradicted the `(7d)` suffix the dashboard derives from
 * the very same `durationMins`. One rule covers every slot, every provider, and
 * a shape no CLI has shipped yet.
 */
export function nameQuotaWindow(durationMins: number | undefined | null): string {
	if (typeof durationMins !== 'number' || !Number.isFinite(durationMins) || durationMins <= 0) {
		return UNKNOWN_QUOTA_WINDOW_NAME;
	}
	if (durationMins === 10080) return 'Weekly';
	if (durationMins === 1440) return 'Daily';
	if (durationMins === 60) return 'Hourly';
	if (durationMins % 10080 === 0) return `${durationMins / 10080}-week`;
	if (durationMins % 1440 === 0) return `${durationMins / 1440}-day`;
	if (durationMins % 60 === 0) return `${durationMins / 60}-hour`;
	return `${durationMins}-minute`;
}
