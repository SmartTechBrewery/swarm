import { getPmMappingProvider } from '@/lib/board-mapping.js';
import { Modal, ModalFooter } from '../ui/modal.js';

/**
 * The review step in front of the one `projects.update` write that moves a project to
 * another PM provider (issue #642).
 *
 * The switch itself is already atomic — the tab holds it as a client-side draft and
 * writes the whole new `pm` union member in a single call — so this dialog exists for
 * the two consequences an operator cannot see from the form:
 *
 * 1. **The outgoing provider's credentials are retained, not destroyed** (the decision
 *    recorded on issue #628 for the SCM side, made possible for the PM side by the
 *    per-provider `credentials.pm` blocks of issue #631). Switching back does not mean
 *    re-entering secrets, and nothing here silently deletes one.
 * 2. **In-flight work is not migrated.** A switch is deliberately *not refused* while
 *    runs are active: refusing would add a cross-cutting lifecycle gate for a rare
 *    operator action, and a queued run can outlive any such check anyway. What that
 *    costs is stated instead — runs already in flight, and the durable
 *    `runs.work_item_id` links behind them, point at the outgoing provider's board and
 *    will not resolve against the new one.
 *
 * Both provider names come from the mapping catalogue, so this names no provider of its
 * own.
 */

const CONFIRM_BUTTON_CLASS =
	'inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-violet-600 rounded-md hover:bg-violet-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-violet-500 transition-colors shadow-lg shadow-violet-650/10 disabled:opacity-55 disabled:cursor-not-allowed';

const CANCEL_BUTTON_CLASS =
	'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-300 bg-zinc-900 border border-zinc-800 rounded-md hover:bg-zinc-800 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 transition-colors disabled:opacity-55 disabled:cursor-not-allowed';

interface PmProviderSwitchDialogProps {
	open: boolean;
	/** The provider the project is persisted on. */
	fromProviderId: string;
	/** The provider the draft mapping selects. */
	toProviderId: string;
	/** A config write is in flight, so the confirm button is inert until it settles. */
	isPending: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}

export function PmProviderSwitchDialog({
	open,
	fromProviderId,
	toProviderId,
	isPending,
	onConfirm,
	onCancel,
}: PmProviderSwitchDialogProps) {
	const from = getPmMappingProvider(fromProviderId);
	const to = getPmMappingProvider(toProviderId);

	return (
		<Modal open={open} onClose={onCancel} title="Switch project-management provider">
			<div className="space-y-4">
				<p className="text-sm text-zinc-300">
					This replaces this project's whole board mapping, moving it from{' '}
					<span className="font-semibold text-zinc-200">{from.label}</span> to{' '}
					<span className="font-semibold text-zinc-200">{to.label}</span>. From then on SWARM reads
					and writes work items on the {to.label} {to.containerNoun} selected below.
				</p>
				<p className="text-sm text-zinc-300">
					{from.label}'s credentials are <span className="font-semibold text-zinc-200">kept</span>,
					so switching back later needs no secrets re-entered.
				</p>
				<div className="p-3 bg-amber-950/20 border border-amber-900/30 text-xs text-amber-200 rounded">
					Work already in flight is not migrated. Runs currently queued or executing — and the work
					items they are linked to — refer to the {from.label} {from.containerNoun} and will not
					resolve on the {to.label} one, so finish or cancel them first if that matters.
				</div>
				<ModalFooter
					primary={
						<button
							type="button"
							onClick={onConfirm}
							disabled={isPending}
							className={CONFIRM_BUTTON_CLASS}
						>
							{isPending ? 'Saving…' : `Switch to ${to.label}`}
						</button>
					}
					secondary={
						<button
							type="button"
							onClick={onCancel}
							disabled={isPending}
							className={CANCEL_BUTTON_CLASS}
						>
							Cancel
						</button>
					}
				/>
			</div>
		</Modal>
	);
}
