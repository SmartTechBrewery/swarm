/**
 * Antigravity's print-mode answers to its own read-only slash commands,
 * decoded into the shared quota vocabulary (`./quota.ts`).
 *
 * `agy` 1.1.11 is what makes a live quota read possible at all: it added
 * print-mode answers for read-only slash commands, so `agy --output-format json
 * -p "/quota"` (`/usage` is an alias) is answered from the CLI's own state — no
 * agent turn, no tokens — and prints a structured `command` block alongside the
 * usual print-mode envelope. Verified live against 1.1.12:
 *
 *   {"command":{"name":"usage","data":{"groups":[
 *     {"name":"Gemini Models","buckets":[
 *       {"id":"gemini-weekly","name":"Weekly Limit Remaining","window":"weekly",
 *        "remaining_fraction":0.9832651615142822,"reset_time":"2026-08-18T09:20:47Z"},
 *       {"id":"gemini-5h","window":"5h","remaining_fraction":1,
 *        "reset_time":"2026-08-11T21:55:11Z"}]},
 *     {"name":"Claude and GPT models","buckets":[…]}]}}}
 *
 *   {"command":{"name":"credits","data":{"remaining_credits":0,
 *     "upgrade_uri":"https://antigravity.google/g1-upgrade"}}}
 *
 * Three shape facts decide how this maps onto `QuotaWindow`:
 *
 *  - **`remaining_fraction` is remaining**, while the schema's field is
 *    `usedPercent` and the dashboard renders `100 - usedPercent`. The fraction is
 *    therefore inverted here rather than stored as reported; storing it as-is
 *    would show an untouched limit as exhausted.
 *  - **Both groups are reported.** Antigravity splits its allowance into a Gemini
 *    group and a Claude/GPT group, each with its own weekly and 5-hour window,
 *    and the four move independently — so all four are emitted rather than
 *    collapsed or picked between. A bucket's own `name` ("Weekly Limit
 *    Remaining") doesn't say which group it belongs to, so a window's name
 *    combines the group with a label derived from the window's *reported*
 *    duration, never from the slot it arrived in.
 *  - **`reset_time` is already an ISO instant**, so it needs no conversion (Codex
 *    reports epoch seconds and does).
 *
 * Only the fields SWARM consumes are modelled (ai/CODING_STANDARDS.md "Zod is
 * the source of truth"); an unknown field or a bucket kind agy has not shipped
 * yet degrades to less detail, never to a failed read.
 */

import { z } from 'zod';
import { antigravityErrorDetail, isAntigravityErrorResult } from './antigravity-stream.js';
import type { QuotaWindow } from './quota.js';

/**
 * One limit inside a group. Everything but the window kind is optional so a
 * build that drops or renames a field still yields the windows it did report.
 */
const AntigravityBucketSchema = z.object({
	id: z.string().optional(),
	name: z.string().optional(),
	window: z.string().optional(),
	remaining_fraction: z.number().optional(),
	reset_time: z.string().optional(),
});
type AntigravityBucket = z.infer<typeof AntigravityBucketSchema>;

/** A family of models sharing one weekly and one 5-hour limit. */
const AntigravityGroupSchema = z.object({
	name: z.string().optional(),
	buckets: z.array(AntigravityBucketSchema).optional(),
});

/** The `data` payload of the `usage` command (`/quota` and its `/usage` alias). */
export const AntigravityUsageDataSchema = z.object({
	groups: z.array(AntigravityGroupSchema).optional(),
});

/** The `data` payload of the `credits` command. */
export const AntigravityCreditsDataSchema = z.object({
	remaining_credits: z.number().optional(),
});

/**
 * The structured answer wrapper. Deliberately non-strict: it arrives *alongside*
 * the ordinary print-mode envelope (`conversation_id`, `status`, `response`, …),
 * and none of those fields are this module's business.
 */
const AntigravityCommandEnvelopeSchema = z.object({
	command: z.object({
		name: z.string(),
		data: z.unknown(),
	}),
});

/** The ordinary print-mode envelope when a slash command itself fails. */
const AntigravityPrintEnvelopeSchema = z.object({
	status: z.string().optional(),
	error: z.string().optional(),
	response: z.string().optional(),
	result: z
		.object({
			error: z.string().optional(),
			response: z.string().optional(),
		})
		.optional(),
});

/** Window kinds agy names rather than measures. */
const NAMED_WINDOW_MINUTES: Record<string, number> = {
	'5h': 300,
	daily: 1440,
	weekly: 10080,
};

/** `<n>h` / `<n>d` / `<n>m`, the measured forms a future bucket kind might use. */
const MEASURED_WINDOW_RE = /^(\d+)\s*(m|min|mins|h|hr|hrs|d)$/;

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/**
 * Every JSON value `stdout` contains: the whole document first (what
 * `--output-format json` prints), then each line on its own so a stray banner
 * ahead of the payload can't hide it.
 */
function* jsonDocuments(stdout: string): Generator<unknown> {
	const whole = parseJson(stdout);
	if (whole !== undefined) yield whole;
	for (const line of stdout.split('\n')) {
		const value = parseJson(line);
		if (value !== undefined) yield value;
	}
}

/**
 * The `data` payload of the named command block in one print-mode answer, or
 * `undefined` when the answer carries none — which is how a build predating
 * print-mode slash commands presents itself, and the observed capability the
 * caller falls back on (never a version comparison; see ai/RULES.md §6).
 */
export function findAntigravityCommandData(stdout: string, name: string): unknown {
	for (const candidate of jsonDocuments(stdout)) {
		const parsed = AntigravityCommandEnvelopeSchema.safeParse(candidate);
		if (parsed.success && parsed.data.command.name === name) return parsed.data.command.data;
	}
	return undefined;
}

/**
 * The detail of a failed print-mode command envelope, if one was present.
 * Successful envelopes without a command block are capability answers, not
 * probe failures, so they deliberately return `undefined` here.
 */
export function findAntigravityPrintError(stdout: string): string | undefined {
	for (const candidate of jsonDocuments(stdout)) {
		const parsed = AntigravityPrintEnvelopeSchema.safeParse(candidate);
		if (!parsed.success) continue;
		const result = {
			status: parsed.data.status,
			error: parsed.data.result?.error ?? parsed.data.error,
			response: parsed.data.result?.response ?? parsed.data.response,
		};
		if (!isAntigravityErrorResult(result)) continue;
		return antigravityErrorDetail(result) || `agy reported ${result.status?.trim() || 'an error'}`;
	}
	return undefined;
}

/** How long the window covers, from what the bucket reported about itself. */
function windowDurationMins(window: string | undefined): number | undefined {
	const token = window?.trim().toLowerCase();
	if (!token) return undefined;
	if (Object.hasOwn(NAMED_WINDOW_MINUTES, token)) return NAMED_WINDOW_MINUTES[token];
	const measured = MEASURED_WINDOW_RE.exec(token);
	if (!measured) return undefined;
	const count = Number(measured[1]);
	if (!count) return undefined;
	return measured[2].startsWith('d')
		? count * 1440
		: measured[2].startsWith('h')
			? count * 60
			: count;
}

/** The human label for a duration — the name says what the window actually is. */
function durationLabel(mins: number): string {
	if (mins % 10080 === 0) return mins === 10080 ? 'Weekly' : `${mins / 10080}-week`;
	if (mins % 1440 === 0) return mins === 1440 ? 'Daily' : `${mins / 1440}-day`;
	if (mins % 60 === 0) return `${mins / 60}-hour`;
	return `${mins}-minute`;
}

function windowName(group: string | undefined, bucket: AntigravityBucket, mins?: number): string {
	const label =
		mins !== undefined
			? durationLabel(mins)
			: bucket.name?.trim() || bucket.window?.trim() || 'Limit';
	return group ? `${group} — ${label}` : label;
}

/**
 * A bucket as a `QuotaWindow`, or `undefined` when it reports no remaining
 * fraction. Dropping such a bucket is deliberate: `usedPercent` is optional and
 * the dashboard reads a missing one as zero used, so keeping it would paint a
 * full green bar over data Antigravity never sent.
 */
function toQuotaWindow(
	group: string | undefined,
	bucket: AntigravityBucket,
): QuotaWindow | undefined {
	const fraction = bucket.remaining_fraction;
	if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return undefined;
	const durationMins = windowDurationMins(bucket.window);
	return {
		name: windowName(group, bucket, durationMins),
		durationMins,
		usedPercent: Math.round((1 - Math.min(1, Math.max(0, fraction))) * 100),
		resetsAt: bucket.reset_time?.trim() || undefined,
	};
}

/** Every reportable bucket of every group, in the order Antigravity listed them. */
function collectWindows(groups: z.infer<typeof AntigravityGroupSchema>[]): QuotaWindow[] {
	const windows: QuotaWindow[] = [];
	for (const group of groups) {
		for (const bucket of group.buckets ?? []) {
			const window = toQuotaWindow(group.name?.trim() || undefined, bucket);
			if (window) windows.push(window);
		}
	}
	return windows;
}

/** What one `/quota` answer says, in the snapshot's own vocabulary. */
export interface AntigravityQuotaReading {
	windows: QuotaWindow[];
	/** Headline allowance: the tightest window's, not an average or a first slot's. */
	remainingPercentage: number;
	resetTime?: string;
}

/**
 * Decode a `usage` command payload, or `undefined` when it names no window at
 * all — nothing to show, so the caller keeps its run-derived fallback.
 *
 * The snapshot-level headline comes from the **most-consumed** window rather
 * than from whichever group agy listed first: with four independent windows,
 * the one nearest exhaustion is the one that will actually block a run.
 */
export function readAntigravityQuota(data: unknown): AntigravityQuotaReading | undefined {
	const parsed = AntigravityUsageDataSchema.safeParse(data);
	if (!parsed.success) return undefined;

	const windows = collectWindows(parsed.data.groups ?? []);
	let tightest = windows[0];
	if (!tightest) return undefined;
	for (const window of windows) {
		if ((window.usedPercent ?? 0) > (tightest.usedPercent ?? 0)) tightest = window;
	}

	return {
		windows,
		remainingPercentage: Math.max(0, 100 - (tightest.usedPercent ?? 0)),
		resetTime: tightest.resetsAt,
	};
}

/**
 * Decode a `credits` command payload into the snapshot's `credits` string, in
 * the same `balance: <n>` vocabulary the Codex path uses.
 *
 * The `typeof` test is load-bearing: a zero balance is a fact about the account,
 * and a truthiness test would report "no credit data" for the operator who most
 * needs to see the number.
 */
export function readAntigravityCredits(data: unknown): string | undefined {
	const parsed = AntigravityCreditsDataSchema.safeParse(data);
	const remaining = parsed.success ? parsed.data.remaining_credits : undefined;
	return typeof remaining === 'number' ? `balance: ${remaining}` : undefined;
}
