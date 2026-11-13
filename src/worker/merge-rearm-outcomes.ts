/**
 * The merge-automation outcome constants that modules outside merge automation
 * also key on — split into this leaf so `src/dispatch/base-push-supersession.ts`
 * (issue #1445), which `./merge-automation.ts` itself calls, can read them
 * without an import cycle. `./merge-automation.ts` re-exports both, so every
 * other importer keeps reading them from there.
 */

/**
 * Terminal outcome recorded once the bounded retry budget is spent while the
 * pull request itself never became ready.
 */
export const MERGE_RETRY_EXHAUSTED = 'retry-exhausted' as const;

/**
 * The merge outcomes a now-green approved head can clear (issue #1128): the
 * red-head refusal (`not-eligible`, issue #1124) and a budget spent waiting for
 * the approved head's pending checks ({@link MERGE_RETRY_EXHAUSTED}). A
 * `not-eligible` with another cause is re-armed too and refused again, harmlessly,
 * because the merge re-verifies the approval and the head. `policy-blocked`,
 * `unsupported` and `provider-error-exhausted` are left out: a green head changes
 * none of them.
 *
 * Also the outcomes an approval parked at a head is superseded from when SWARM's
 * own base merge moves the pull request off that head (issue #1445,
 * `supersedeApprovalsParkedAtHead`): a merge still waiting keeps its own
 * head-moved stamping, and a merged one has no further pushes.
 */
export const MERGE_REARM_OUTCOMES = ['not-eligible', MERGE_RETRY_EXHAUSTED] as const;
