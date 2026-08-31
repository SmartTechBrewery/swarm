import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { AgentCli, AgentCliResult } from '../harness/agent-cli.js';
import { logger } from '../lib/logger.js';

const execFileAsync = promisify(execFile);

// Git exports repository-local variables while running hooks. They override
// `cwd`, so carrying them into a worktree delivery can redirect commands to
// the hook's repository/index. Preserve transport/auth variables, but always
// let the requested worktree determine repository location.
const repositoryLocalGitEnvironment = [
	'GIT_ALTERNATE_OBJECT_DIRECTORIES',
	'GIT_CONFIG',
	'GIT_CONFIG_PARAMETERS',
	'GIT_OBJECT_DIRECTORY',
	'GIT_DIR',
	'GIT_WORK_TREE',
	'GIT_IMPLICIT_WORK_TREE',
	'GIT_GRAFT_FILE',
	'GIT_INDEX_FILE',
	'GIT_NO_REPLACE_OBJECTS',
	'GIT_REPLACE_REF_BASE',
	'GIT_PREFIX',
	'GIT_INTERNAL_SUPER_PREFIX',
	'GIT_SHALLOW_FILE',
	'GIT_COMMON_DIR',
] as const;

/**
 * The environment a `git` invocation must run with when `cwd` alone decides which
 * repository it acts on. Exported because every worktree-scoped git read needs the
 * same scrubbing, not only delivery's writes — the checkpoint continuation gate
 * (`src/pipeline/checkpoint.ts`) reads `git status` inside a worktree and would
 * otherwise be redirected by an inherited `GIT_DIR`/`GIT_WORK_TREE`. One list, so
 * the two cannot drift.
 */
export function gitEnvironmentForCwd(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of repositoryLocalGitEnvironment) delete env[key];
	return env;
}

export const VerificationSchema = z.object({
	command: z.string().min(1),
	outcome: z.literal('passed'),
});

const CommitSchema = z.object({
	commitSubject: z.string().min(1).max(200),
	verification: z.array(VerificationSchema).min(1),
});

export const ImplementationHandoffSchema = CommitSchema.extend({
	summary: z.string().min(1),
	limitations: z.array(z.string()).default([]),
	readyForDelivery: z.literal(true),
});

/**
 * A command the reviewer ran, and whether it passed. Unlike
 * {@link VerificationSchema} — which the *implementation* hand-off uses, where a
 * failing command means the work isn't deliverable — a reviewer's failing
 * command is itself evidence for a finding, so `failed` is a legitimate outcome
 * to report rather than a reason to reject the hand-off (issue #470).
 */
export const ReviewVerificationSchema = z.object({
	command: z.string().min(1),
	outcome: z.enum(['passed', 'failed']),
});

/**
 * Severity decides two things mechanically: which slots a finding must fill
 * (see {@link ReviewHandoffSchema}'s refinement) and the run's verdict. Only
 * `blocker`/`major` block a PR.
 */
export const REVIEW_FINDING_SEVERITIES = ['blocker', 'major', 'minor', 'nit'] as const;
export type ReviewFindingSeverity = (typeof REVIEW_FINDING_SEVERITIES)[number];

/** Closed vocabulary, so the same defect gets the same label on every model/CLI (issue #470). */
export const REVIEW_FINDING_CATEGORIES = [
	'correctness',
	'security',
	'contract',
	'performance',
	'test-coverage',
	'docs',
	'consistency',
] as const;

/** Whether a severity blocks the PR — the single rule the verdict derives from. */
export function isBlockingSeverity(severity: ReviewFindingSeverity): boolean {
	return severity === 'blocker' || severity === 'major';
}

/** What a re-review concluded about a finding an earlier pass raised. */
export const REVIEW_CARRIED_STATUSES = ['resolved', 'partial', 'outstanding', 'regressed'] as const;

const ReviewFindingSchema = z.object({
	/** `F<n>`, minted by the pass that first raised it and carried by every later pass. */
	id: z.string().regex(/^F\d+$/, 'finding id must be F<n>'),
	title: z.string().min(1),
	severity: z.enum(REVIEW_FINDING_SEVERITIES),
	category: z.enum(REVIEW_FINDING_CATEGORIES),
	/** Required at every severity: the `file:line` anchors the claim rests on. */
	evidence: z.string().min(1),
	// Blocking tier (blocker/major) — required there, forbidden below it.
	failureScenario: z.string().min(1).optional(),
	impact: z.string().min(1).optional(),
	fixPlan: z.array(z.string().min(1)).min(1).optional(),
	tests: z.string().min(1).optional(),
	// Compact tier (minor/nit) — one paragraph instead of five slots, because the
	// suggestion *is* the plan and the full treatment turns a naming nit into 200
	// words. `downgradeRationale` is the pressure valve: it lets a reviewer justify
	// calling something minor rather than quietly parking a real defect there.
	suggestion: z.string().min(1).optional(),
	downgradeRationale: z.string().min(1).optional(),
});

export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

const ReviewDocCheckSchema = z.object({
	path: z.string().min(1),
	status: z.enum(['accurate', 'updated', 'not-applicable', 'stale']),
	note: z.string().optional(),
});

export type ReviewDocCheck = z.infer<typeof ReviewDocCheckSchema>;

const ReviewCarriedSchema = z.object({
	id: z.string().regex(/^F\d+$/, 'carried finding id must be F<n>'),
	title: z.string().min(1),
	status: z.enum(REVIEW_CARRIED_STATUSES),
	detail: z.string().min(1),
});

export type ReviewCarriedFinding = z.infer<typeof ReviewCarriedSchema>;

/** Which slots each severity tier must fill, and which it must leave empty. */
const BLOCKING_SLOTS = ['failureScenario', 'impact', 'fixPlan', 'tests'] as const;
const COMPACT_SLOTS = ['suggestion', 'downgradeRationale'] as const;

/**
 * Enforce the two rendering tiers, and unique finding ids.
 *
 * Done in the schema rather than asked for in the prompt because a model can
 * neither be trusted to pad a nit into five slots nor to trace a blocker's
 * failure scenario — and the renderer (`src/pipeline/review-body.ts`) relies on
 * each tier's slots being present. Ids must be unique because a re-review's
 * disposition and the respond-to-review flow key on them, so a collision would
 * silently merge two problems into one.
 */
function checkFindingTiers(findings: readonly ReviewFinding[], ctx: z.RefinementCtx): void {
	const seen = new Set<string>();
	for (const [index, finding] of findings.entries()) {
		if (seen.has(finding.id))
			ctx.addIssue({
				code: 'custom',
				path: ['findings', index, 'id'],
				message: `duplicate finding id ${finding.id}`,
			});
		seen.add(finding.id);
		checkFindingSlots(finding, index, ctx);
	}
}

/** One finding's required/forbidden slots for its tier. Split out for the complexity budget. */
function checkFindingSlots(finding: ReviewFinding, index: number, ctx: z.RefinementCtx): void {
	const blocking = isBlockingSeverity(finding.severity);
	const required = blocking ? BLOCKING_SLOTS : ([COMPACT_SLOTS[0]] as const);
	const forbidden = blocking ? COMPACT_SLOTS : BLOCKING_SLOTS;
	const issue = (field: string, message: string) =>
		ctx.addIssue({
			code: 'custom',
			path: ['findings', index, field],
			message: `${finding.id} is ${finding.severity}, so ${field} ${message}`,
		});
	for (const field of required) if (finding[field] === undefined) issue(field, 'is required');
	for (const field of forbidden) if (finding[field] !== undefined) issue(field, 'must be omitted');
}

/**
 * Every carried item a re-review did **not** resolve must reappear in `findings`
 * under the same id.
 *
 * Without this the two lists are independent, so a re-review could render a
 * disposition table reading "F1 ❌ not addressed" above the verdict `approve` —
 * clearing the review gate and, with `pipeline.respondToReview.autoMerge` on,
 * merging a PR whose requested changes were never made. Routing the item through
 * `findings` instead of coupling it to the verdict directly is deliberate: it
 * lets {@link checkVerdictMatchesSeverities} do the verdict work from the
 * severity the reviewer assigns, so a still-outstanding *nit* from an earlier
 * pass can be approved while a still-outstanding blocker cannot. It is also what
 * makes an `F<n>` id stable across passes rather than merely unique within one.
 */
function checkCarriedItemsAreReported(
	carried: readonly ReviewCarriedFinding[],
	findings: readonly ReviewFinding[],
	ctx: z.RefinementCtx,
): void {
	const reported = new Set(findings.map((f) => f.id));
	for (const [index, item] of carried.entries()) {
		if (item.status === 'resolved' || reported.has(item.id)) continue;
		ctx.addIssue({
			code: 'custom',
			path: ['carried', index, 'status'],
			message: `${item.id} is ${item.status}, so it must also appear in findings under the same id`,
		});
	}
}

/**
 * The verdict is a pure function of the severity histogram, so it is enforced
 * rather than instructed — this is what makes "blocker" and "approve" mean the
 * same thing whichever model produced the review, which prose alone never
 * achieved.
 */
function checkVerdictMatchesSeverities(
	verdict: 'approve' | 'request-changes',
	findings: readonly ReviewFinding[],
	ctx: z.RefinementCtx,
): void {
	const blocking = findings.filter((f) => isBlockingSeverity(f.severity));
	if (blocking.length > 0 && verdict !== 'request-changes')
		ctx.addIssue({
			code: 'custom',
			path: ['verdict'],
			message: `${blocking.map((f) => f.id).join(', ')} ${blocking.length === 1 ? 'is' : 'are'} blocker/major, so the verdict must be request-changes`,
		});
	if (blocking.length === 0 && verdict === 'request-changes')
		ctx.addIssue({
			code: 'custom',
			path: ['verdict'],
			message: 'request-changes requires at least one blocker/major finding',
		});
}

/**
 * The Review phase's hand-off (issue #470). The agent fills **fields**, never
 * layout: `src/pipeline/review-body.ts` renders the posted review body from
 * these, so the structure is identical on every model and CLI. That is why there
 * is no `body` here — the previous shape had one, and having the agent author the
 * whole body was exactly what let each harness invent its own format.
 *
 * `verdict` is deliberately only `approve`/`request-changes`. The old third
 * option, `comment`, mirrored `gh pr review`'s event flags rather than any SWARM
 * state, and it closed every exit at once: no merge dispatch (only `approve`
 * persists one), no Respond-to-review run (skipped as a minor verdict under the
 * default `skipOnMinors`), a consumed slot against `REVIEW_VERDICT_CAP`, and no
 * `manual-intervention-required` signal — so the PR looked reviewed and was
 * silently terminal. A reviewer that cannot reach a verdict must fail its run,
 * which retries, rather than post a terminal non-verdict.
 */
export const ReviewHandoffSchema = z
	.object({
		verdict: z.enum(['approve', 'request-changes']),
		/** The `## Scope` paragraph: what the change is and what was confirmed. */
		summary: z.string().min(1),
		verification: z.array(ReviewVerificationSchema).min(1),
		/**
		 * One row per document the reviewed repository requires to stay current —
		 * its README plus whatever its own contributor/agent guide names. Which
		 * documents those are is the repository's business, not SWARM's: this phase
		 * reviews any project SWARM manages, so nothing here names a path.
		 */
		docsChecked: z.array(ReviewDocCheckSchema).min(1),
		/** Conditions the reviewer found but that predate this PR, so they aren't charged to it. */
		preExisting: z.array(z.string().min(1)).default([]),
		findings: z.array(ReviewFindingSchema).default([]),
		/**
		 * Re-review only: what became of each finding an earlier pass raised. Anything
		 * not `resolved` must also be reported in `findings` under the same id
		 * ({@link checkCarriedItemsAreReported}), which is what keeps the disposition
		 * table and the verdict from contradicting each other.
		 */
		carried: z.array(ReviewCarriedSchema).default([]),
	})
	.superRefine((handoff, ctx) => {
		checkFindingTiers(handoff.findings, ctx);
		checkCarriedItemsAreReported(handoff.carried, handoff.findings, ctx);
		checkVerdictMatchesSeverities(handoff.verdict, handoff.findings, ctx);
	});

export type ReviewHandoff = z.infer<typeof ReviewHandoffSchema>;

/**
 * The pre-#470 hand-off shape, accepted **only** when resuming a delivery whose
 * worktree an older agent already wrote (`src/pipeline/review.ts`). A fresh run
 * must satisfy {@link ReviewHandoffSchema}; without this fallback an in-flight
 * half-delivered review would fail validation on every retry instead of
 * completing the submission it had already started.
 */
export const LegacyReviewHandoffSchema = z.object({
	verdict: z.enum(['approve', 'request-changes', 'comment']),
	body: z.string().min(1),
	findings: z
		.array(
			z.object({
				title: z.string().min(1),
				body: z.string().min(1),
				fixPlan: z.string().min(1),
			}),
		)
		.default([]),
});

export type LegacyReviewHandoff = z.infer<typeof LegacyReviewHandoffSchema>;

export const ReviewResponseHandoffSchema = z.object({
	outcome: z.enum(['fixed', 'pushed-back', 'no-findings']),
	body: z.string().min(1),
	commitSubject: z.string().min(1).max(200).optional(),
	verification: z.array(VerificationSchema).default([]),
});

export const CiResponseHandoffSchema = z.object({
	outcome: z.enum(['fixed', 'no-fix']),
	body: z.string().min(1),
	commitSubject: z.string().min(1).max(200).optional(),
	verification: z.array(VerificationSchema).default([]),
});

export const ConflictHandoffSchema = z.object({
	status: z.literal('resolved'),
	body: z.string().min(1),
	verification: z.array(VerificationSchema).min(1),
});

export const DeliveryProgressSchema = z.object({
	deliveryId: z.string(),
	commitSha: z.string().optional(),
	pushed: z.boolean().default(false),
	pullRequestNumber: z.number().int().positive().optional(),
	pullRequestUrl: z.string().url().optional(),
	reviewId: z.number().int().positive().optional(),
	commentId: z.number().int().positive().optional(),
	/**
	 * Whether the follow-up Review for a `fixed` Respond-to-review response has
	 * already been enqueued (issue #241) — checked before
	 * {@link ScheduleFollowUpReview} runs so a resumed delivery retry doesn't
	 * re-enqueue once the checkpoint is saved (the queue's own deterministic job
	 * id already absorbs a repeat in the narrower crash window before this is
	 * written).
	 */
	followUpEnqueued: z.boolean().default(false),
});
export type DeliveryProgress = z.infer<typeof DeliveryProgressSchema>;

export interface CreatePullRequestInput {
	baseBranch: string;
	branch: string;
	title: string;
	body: string;
}

export interface ScmDeliveryProvider {
	commitIdentity: { name: string; email: string };
	findPullRequest(branch: string): Promise<{ number: number; url: string } | undefined>;
	createPullRequest(input: CreatePullRequestInput): Promise<{ number: number; url: string }>;
	pushBranch(cwd: string, branch: string, expectedSha: string): Promise<void>;
	submitReview(input: {
		prNumber: number;
		verdict: z.infer<typeof ReviewHandoffSchema>['verdict'];
		body: string;
		deliveryId: string;
	}): Promise<number>;
	postComment(input: { prNumber: number; body: string; deliveryId: string }): Promise<number>;
}

export const HANDOFF_FILENAMES = {
	implementation: 'implementation_handoff.json',
	review: 'review_handoff.json',
	respondToReview: 'respond_to_review_handoff.json',
	respondToCi: 'respond_to_ci_handoff.json',
	resolveConflicts: 'resolve_conflicts_handoff.json',
	/**
	 * Not a phase delivery contract like the five above — the continuation
	 * hand-off an implementer phase keeps current so a run cut short can be
	 * continued from the recorded remainder (`src/pipeline/checkpoint.ts`,
	 * `docs/CHECKPOINTS.md` Tier 2). It is registered here precisely because
	 * {@link SCRATCH_PATHSPECS} is derived from this object: that is what makes
	 * `validatePreparedTree` reject it when tracked and `commitPreparedTree`
	 * unstage it, so it can never land in a customer PR.
	 */
	checkpoint: 'swarm_checkpoint.json',
} as const;

const PROGRESS_FILENAME = '.swarm_delivery.json';
export const SCRATCH_PATHSPECS = [...Object.values(HANDOFF_FILENAMES), PROGRESS_FILENAME] as const;

export class DeliveryDeferredError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'DeliveryDeferredError';
	}
}

/**
 * A delivery failure no retry can get past, because nothing that runs between
 * attempts can change what it refused on (issue #839).
 *
 * Deliberately **not** a {@link DeliveryDeferredError}. A deferral preserves the
 * checkout and resumes the delivery *without re-running the agent*
 * ({@link resumedDeliveryAgent}), so the retry re-validates byte-identical state
 * and fails identically — spending the whole `MAX_RATE_LIMIT_RETRIES` budget and
 * its backoff while the preserved checkout keeps the branch away from the phase
 * that could actually unblock the PR. Every failure classifier keys deferral off
 * `DeliveryDeferredError` alone (`classifyDeferrable`,
 * `src/transport/assignment-execution.ts`; `handlePhaseFailure`,
 * `src/worker/consumer.ts`), so *not* being one is what makes this terminal on
 * the same-host and DB-free paths alike.
 *
 * This is a **rule, not a list**: every refusal {@link validatePreparedTree} and
 * {@link commitPreparedTree} can raise is thrown as one of these (see
 * `refuseDelivery`), so the next refusal added there is terminal without anyone
 * remembering to classify it. Because the error *class* does not survive the
 * federated wire (the dispatcher rebuilds a remote worker's terminal failure as
 * `AgentRunError{kind:'error'}`), the message is the whole report the operator
 * gets — it must name the state that was refused and what clears it.
 */
export class UnretryableDeliveryError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'UnretryableDeliveryError';
	}
}

/**
 * The first member of the {@link UnretryableDeliveryError} rule (issue #558): a
 * push that cannot succeed however many times it is retried, because the
 * delivered commit is not a descendant of what `origin` already has on the
 * branch. A diverged branch produces the identical `! [rejected] (fetch first)`
 * on every attempt, so retrying buys nothing but the retry budget (four attempts
 * over ~35 minutes in the incident this comes from).
 *
 * Kept as its own class — and its own `name` — because the divergence has two
 * SHAs to name in the message the run, the board, and the logs all carry.
 */
export class DeliveryDivergedError extends UnretryableDeliveryError {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'DeliveryDivergedError';
	}
}

/**
 * Refuse to deliver this tree, terminally. Every refusal
 * {@link validatePreparedTree} and {@link commitPreparedTree} can raise goes
 * through here — that funnel is what makes the classification a rule rather than
 * a second hard-coded class beside {@link DeliveryDivergedError}: a new refusal
 * added to either function cannot be a plain `Error` without going out of its
 * way to be one.
 *
 * `remedy` is not decoration. This message is the whole report an operator gets:
 * the terminal path posts it on the PR or board item
 * (`reportPhaseFailureToBoardOrPr`, `src/worker/consumer.ts`), so it must say
 * what state was refused and what clears it. The `Unsafe delivery:` prefix stays
 * — operators key on it.
 */
function refuseDelivery(reason: string, remedy: string): never {
	throw new UnretryableDeliveryError(`Unsafe delivery: ${reason}. ${remedy}`);
}

export function resumedDeliveryAgent(cli: AgentCli): AgentCliResult {
	return {
		cli,
		exitCode: 0,
		signal: null,
		stdout: '',
		stderr: '',
		durationMs: 0,
		timedOut: false,
		aborted: false,
		outputTruncated: false,
	};
}

// Input parameter widened to `unknown` (the parsed JSON is exactly that), so a
// schema carrying defaults or a `superRefine` — whose input type differs from its
// output — still infers `T` as the *output* type rather than collapsing to the
// looser input shape.
export function readHandoff<T>(
	cwd: string,
	filename: string,
	schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): T {
	const path = join(cwd, filename);
	if (!existsSync(path)) throw new Error(`Agent did not write required hand-off ${filename}`);
	try {
		return schema.parse(JSON.parse(readFileSync(path, 'utf8')));
	} catch (error) {
		throw new Error(
			`Invalid hand-off ${filename}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export function deliveryIdentity(parts: readonly string[]): string {
	return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32);
}

export function loadDeliveryProgress(cwd: string, deliveryId: string): DeliveryProgress {
	const path = join(cwd, PROGRESS_FILENAME);
	if (!existsSync(path)) return { deliveryId, pushed: false, followUpEnqueued: false };
	const progress = DeliveryProgressSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
	if (progress.deliveryId !== deliveryId)
		throw new Error('Delivery progress belongs to another operation');
	return progress;
}

export function saveDeliveryProgress(cwd: string, progress: DeliveryProgress): void {
	writeFileSync(join(cwd, PROGRESS_FILENAME), `${JSON.stringify(progress, null, 2)}\n`, {
		mode: 0o600,
	});
}

export function hasDeliveryProgress(cwd: string): boolean {
	return existsSync(join(cwd, PROGRESS_FILENAME));
}

/**
 * Whether this failure — or any failure it wraps — is one no retry can get past.
 *
 * Walks the `cause` chain (as `describeError` does) so wrapping a refusal on the
 * way out of a phase cannot silently re-open the retry loop this closes.
 */
export function isUnretryableDeliveryFailure(error: unknown): boolean {
	const seen = new Set<unknown>();
	let current: unknown = error;
	while (current instanceof Error && !seen.has(current)) {
		if (current instanceof UnretryableDeliveryError) return true;
		seen.add(current);
		current = current.cause;
	}
	return false;
}

/**
 * Whether a failed delivery should be deferred for a retry that resumes from the
 * preserved checkout — the rule every pushing phase's failure path applies, in
 * one place so the four cannot drift.
 *
 * Two conditions: the attempt must have recorded delivery progress, so there *is*
 * something to resume, and the failure must be one a retry could plausibly get
 * past. An {@link UnretryableDeliveryError} is not, and that class — not a named
 * error — is the whole test (issue #839). Issue #558's {@link
 * DeliveryDivergedError} is its first member: the remote already holds a commit
 * the delivered one does not descend from, so every retry repeats the identical
 * rejection. Every prepared-tree refusal is another: a retry resumes *without*
 * re-running the agent, so it re-validates the same tree and refuses it again.
 */
export function shouldDeferDeliveryFailure(error: unknown, cwd: string): boolean {
	return !isUnretryableDeliveryFailure(error) && hasDeliveryProgress(cwd);
}

async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync('git', args, { cwd, env: gitEnvironmentForCwd() });
	return stdout.trim();
}

/** Multi-path git output reads as one sentence rather than stray lines. */
function joinPaths(output: string): string {
	return output.split('\n').join(', ');
}

/**
 * Refuse a prepared tree that must not be committed. Everything raised here is
 * terminal by construction — it goes through `refuseDelivery`, so it is an
 * {@link UnretryableDeliveryError} and `shouldDeferDeliveryFailure` will not spend
 * the retry budget re-validating a tree nothing between attempts can change. A
 * refusal added here inherits that; keep it going through the same helper.
 */
export async function validatePreparedTree(cwd: string): Promise<void> {
	const unresolved = await git(cwd, ['diff', '--name-only', '--diff-filter=U']);
	if (unresolved)
		refuseDelivery(
			`the index still holds unresolved conflicts in ${joinPaths(unresolved)}`,
			"Nothing runs between delivery attempts that could stage them, so this was not retried. Mark each resolved path with 'git add' ('git rm' for a delete/delete conflict), then re-run this phase.",
		);
	const status = await git(cwd, ['status', '--porcelain']);
	if (!status)
		refuseDelivery(
			'the phase reported a deliverable result but the working tree holds no changes at all',
			'Nothing was committed, pushed, or commented; re-run the phase.',
		);
	const trackedScratch = await git(cwd, ['ls-files', '--', ...SCRATCH_PATHSPECS]);
	if (trackedScratch)
		refuseDelivery(
			`SWARM scratch artifact ${joinPaths(trackedScratch)} is tracked by the repository`,
			"Untrack it ('git rm --cached <path>') and ignore it, then re-run this phase.",
		);
}

export async function commitPreparedTree(
	cwd: string,
	subject: string,
	identity: { name: string; email: string },
): Promise<string> {
	await validatePreparedTree(cwd);
	await git(cwd, ['add', '--all', '--', '.']);
	// `git add` treats an explicitly named ignored path as an error, even when it
	// is an exclude pathspec. Unstage hand-off files after adding instead.
	await git(cwd, ['reset', '--quiet', '--', ...SCRATCH_PATHSPECS]);
	const staged = await git(cwd, ['diff', '--cached', '--name-only']);
	if (!staged)
		refuseDelivery(
			'every change in the working tree is a SWARM hand-off artifact, so there is nothing to deliver',
			'Nothing was committed or pushed; re-run the phase.',
		);
	await git(cwd, [
		'-c',
		`user.name=${identity.name}`,
		'-c',
		`user.email=${identity.email}`,
		'commit',
		'--no-verify',
		'-m',
		subject,
	]);
	return git(cwd, ['rev-parse', 'HEAD']);
}

export async function assertRemoteHead(
	cwd: string,
	branch: string,
	expectedSha: string,
): Promise<void> {
	await git(cwd, ['fetch', 'origin', branch]);
	const remote = await git(cwd, ['rev-parse', `origin/${branch}`]);
	if (remote !== expectedSha)
		throw new Error(`Remote head drift for ${branch}: expected ${expectedSha}, found ${remote}`);
}

/**
 * The exit code git reported, or `null` when the failure was not git answering at
 * all (a spawn failure, a killed process). Only the codes git documents are
 * actionable: everything else has to be read as "no answer".
 */
function gitExitCode(error: unknown): number | null {
	if (typeof error !== 'object' || error === null || !('code' in error)) return null;
	const code = (error as { code: unknown }).code;
	return typeof code === 'number' ? code : null;
}

/**
 * Whether `descendant` contains `ancestor` — the module's one spelling of the
 * "contains, not equals" rule, and the same question `localRefBehindRemote` asks in
 * `src/worker/git-worktree-manager.ts`, so nothing here can grow a second
 * definition of "diverged".
 *
 * `null` when git could not evaluate the question at all. `merge-base
 * --is-ancestor` exits **1** for a clean "no" and **128** for a question it could
 * not answer (an absent or unresolvable commit), and collapsing the two is what
 * would let a git blip read as a rewritten branch — so the distinction is kept here
 * and each caller decides which way to fail.
 */
async function isAncestor(
	cwd: string,
	ancestor: string,
	descendant: string,
): Promise<boolean | null> {
	try {
		await git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
		return true;
	} catch (error) {
		return gitExitCode(error) === 1 ? false : null;
	}
}

/**
 * Whether this checkout holds `sha` at all: `true`, a confirmed `false`, or `null`
 * when git could not answer the question.
 *
 * The object is deliberately *not* peeled to `^{commit}`. `cat-file -e` exits **1**
 * only for an object name it resolved and found missing, and peeling turns that
 * missing object into the same **128** git reports for a string that is no object
 * name at all — which would make an unresolvable dispatched ref (`'not-a-sha'`) as
 * terminal as a force-push. Unpeeled, exit 1 *is* the force-pushed commit and 128 is
 * "ask someone else", which is the split {@link assertCheckoutHoldsHead} needs.
 * Whether the object is a commit is a question `merge-base --is-ancestor` asks next,
 * and fails open on.
 */
async function commitPresent(cwd: string, sha: string): Promise<boolean | null> {
	try {
		await git(cwd, ['cat-file', '-e', sha]);
		return true;
	} catch (error) {
		return gitExitCode(error) === 1 ? false : null;
	}
}

/**
 * The report for a branch whose dispatched head is gone. The error class does not
 * survive the federated wire, so this message is the whole thing an operator gets
 * (see {@link UnretryableDeliveryError}): it names the branch, the commit the
 * dispatch was pinned to, and what is on the branch instead.
 */
function rewrittenHeadMessage(branch: string, expectedSha: string, head: string): string {
	return (
		`Branch '${branch}' no longer contains ${expectedSha}, the head this phase was dispatched ` +
		`for: it is now at ${head}, which does not descend from it, so that commit was rewritten ` +
		`out of the branch by a force-push or a rebase. Nothing an agent wrote against this ` +
		`checkout could answer the event that dispatched it, so no agent was run and nothing was ` +
		`committed or pushed. Re-run this phase for ${head} once the branch has settled.`
	);
}

/**
 * Whether the checkout still holds the commit this dispatch was pinned to (issue
 * #850), asked *before* the agent runs — so a branch that moved under a writing
 * phase is reported as what it is, rather than as a rejected push an entire agent
 * run later.
 *
 * `'unchanged'` when HEAD *is* that commit — no network call and no log, so the
 * ordinary case behaves exactly as it did. `{ advancedTo }` when HEAD contains it:
 * the branch moved on legitimately — a Resolve-conflicts merge landing while this
 * dispatch waited on the PR-scoped hold (issue #850 phase 1/2) is the routine
 * case — and the response belongs on the newer tip, so the caller warns and carries
 * on rather than failing. Throws an {@link UnretryableDeliveryError} when HEAD does
 * not contain it at all: the reviewed/checked commit was rewritten out of the
 * branch, so nothing the agent writes against this tree answers the event that
 * dispatched it, and a retry would only re-validate identical state (issue #839).
 *
 * Fails **open** on git failing to answer — logged and reported `'unchanged'`,
 * because a blip must not fail a phase that would otherwise have succeeded and
 * {@link pushDeliveredBranch} still classifies a real divergence. That covers a head
 * that cannot be read, an ancestry git will not evaluate, and a dispatched ref git
 * cannot resolve as an object name at all: none of the three is evidence the branch
 * was rewritten. Only a *confirmed* absence is terminal — `merge-base --is-ancestor`
 * cannot tell that from a broken repository (both exit 128) and a force-pushed branch
 * is exactly where the object is gone, so presence is probed separately by
 * {@link commitPresent}, which reports absence only when git resolved the name and
 * found nothing.
 */
export async function assertCheckoutHoldsHead(
	cwd: string,
	branch: string,
	expectedSha: string,
): Promise<'unchanged' | { advancedTo: string }> {
	let head: string;
	try {
		head = await git(cwd, ['rev-parse', 'HEAD']);
	} catch (error) {
		logger.warn('Could not read the checkout head — proceeding without the dispatched-head check', {
			branch,
			expectedSha,
			error: error instanceof Error ? error.message : String(error),
		});
		return 'unchanged';
	}
	if (head === expectedSha) return 'unchanged';
	const present = await commitPresent(cwd, expectedSha);
	if (present === null) {
		logger.warn('Git could not resolve the dispatched head — proceeding without the check', {
			branch,
			expectedSha,
			head,
		});
		return 'unchanged';
	}
	if (!present) throw new UnretryableDeliveryError(rewrittenHeadMessage(branch, expectedSha, head));
	const contains = await isAncestor(cwd, expectedSha, head);
	if (contains === null) {
		logger.warn('Git could not compare the checkout head with the dispatched head — proceeding', {
			branch,
			expectedSha,
			head,
		});
		return 'unchanged';
	}
	if (!contains)
		throw new UnretryableDeliveryError(rewrittenHeadMessage(branch, expectedSha, head));
	return { advancedTo: head };
}

/**
 * What git says when it refuses a non-fast-forward update. Matched against both
 * the error message and its captured `stderr`, because `execFile` surfaces the
 * output in one, the other, or both depending on how the provider spawns `git`.
 */
const PUSH_REJECTION_MARKERS = [
	'! [rejected]',
	'non-fast-forward',
	'fetch first',
	'updates were rejected',
];

function looksLikePushRejection(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) return false;
	const message = error instanceof Error ? error.message : '';
	const stderr = 'stderr' in error ? String((error as { stderr: unknown }).stderr) : '';
	const text = `${message}\n${stderr}`.toLowerCase();
	return PUSH_REJECTION_MARKERS.some((marker) => text.includes(marker));
}

/**
 * The remote head when the branch has genuinely diverged from `expectedSha`, or
 * `null` when it has not (or when git cannot answer).
 *
 * "Diverged" is the precise question `git push` refused on: is the remote tip an
 * ancestor of the commit being delivered? A rejection whose remote tip *is* an
 * ancestor was not a divergence at all (a concurrent hook, a protected-branch
 * rule, a race that has since resolved), so it stays a retryable failure — and
 * so does any rejection this cannot verify, which keeps a network/`fetch`
 * failure from being misreported as unpushable work.
 */
async function divergedRemoteHead(
	cwd: string,
	branch: string,
	expectedSha: string,
): Promise<string | null> {
	try {
		await git(cwd, ['fetch', 'origin', branch]);
		const remote = await git(cwd, ['rev-parse', `origin/${branch}`]);
		if (!remote || remote === expectedSha) return null;
		// An unanswerable ancestry check keeps this classifier's existing verdict: it is
		// only ever consulted about a push git *already* rejected, so the rejection is
		// the evidence and `isAncestor` only has to confirm the direction.
		return (await isAncestor(cwd, remote, expectedSha)) === true ? null : remote;
	} catch {
		return null;
	}
}

/**
 * The one wording for a branch that cannot fast-forward, so an operator reads the
 * same report whichever side catches it (issue #850) — the push git rejected, or the
 * pre-commit assert that got there first. Only the subject differs: once the commit
 * exists there is a delivered commit to reconcile or discard, and before it does
 * there is only the checkout it would have been built on.
 */
function divergedBranchMessage(
	branch: string,
	remote: string,
	local: { sha: string; committed: boolean },
): string {
	const subject = local.committed
		? `the delivered commit ${local.sha}`
		: `this phase's checkout, which is at ${local.sha}`;
	const remedy = local.committed
		? `The delivered commit stays on the local '${branch}' ref for inspection; reconcile it ` +
			`with origin/${branch} (or discard it) before re-running this phase.`
		: `Nothing was committed or pushed; re-run this phase against the branch's current head.`;
	return (
		`Branch '${branch}' has diverged: origin/${branch} is at ${remote}, which is not an ` +
		`ancestor of ${subject}, so this push can never fast-forward. ${remedy}`
	);
}

/**
 * Refuse to build a commit that can never be pushed (issue #850) — the pre-commit
 * assert Resolve-conflicts already makes ({@link assertRemoteHead}), asked as the
 * question a push actually refuses on: is `origin/<branch>` still an ancestor of
 * what we are about to commit on top of? Asked *before* the commit exists, so the
 * honest report replaces the doomed commit rather than following it a push
 * round-trip later.
 *
 * Same {@link DeliveryDivergedError} and the same wording as {@link
 * pushDeliveredBranch}, so an operator reads one report whichever side catches it.
 * Fails **open** on a git error, exactly as `divergedRemoteHead` already does: a
 * failed fetch must not fail a phase, and the push still classifies a real
 * divergence.
 */
export async function assertRemoteFastForwardable(cwd: string, branch: string): Promise<void> {
	let head: string;
	try {
		head = await git(cwd, ['rev-parse', 'HEAD']);
	} catch (error) {
		logger.warn('Could not read the checkout head — proceeding without the fast-forward check', {
			branch,
			error: error instanceof Error ? error.message : String(error),
		});
		return;
	}
	const remote = await divergedRemoteHead(cwd, branch, head);
	if (remote)
		throw new DeliveryDivergedError(
			divergedBranchMessage(branch, remote, { sha: head, committed: false }),
		);
}

/**
 * Push a delivered commit, turning an unwinnable push into a terminal
 * {@link DeliveryDivergedError} instead of a retry (issue #558).
 *
 * Every phase that pushes goes through here rather than calling
 * `ScmDeliveryProvider.pushBranch` directly, so the classification is one
 * provider-neutral rule rather than six copies inside the SCM adapters: the
 * adapters keep spelling the push in their own vocabulary, and this reads only
 * what git reported about the *refusal*. Anything it cannot prove is a
 * divergence is rethrown untouched and stays deferrable.
 */
export async function pushDeliveredBranch(
	delivery: Pick<ScmDeliveryProvider, 'pushBranch'>,
	cwd: string,
	branch: string,
	expectedSha: string,
): Promise<void> {
	try {
		await delivery.pushBranch(cwd, branch, expectedSha);
	} catch (error) {
		if (!looksLikePushRejection(error)) throw error;
		const remote = await divergedRemoteHead(cwd, branch, expectedSha);
		if (!remote) throw error;
		throw new DeliveryDivergedError(
			divergedBranchMessage(branch, remote, { sha: expectedSha, committed: true }),
			{ cause: error },
		);
	}
}
