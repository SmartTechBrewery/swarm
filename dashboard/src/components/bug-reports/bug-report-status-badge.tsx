import type { ComponentProps } from 'react';
import {
	BUG_REPORT_STATUS_DESCRIPTIONS,
	type BugReportStatus,
} from '../../../../src/api/bug-reports.js';

/**
 * A bug report's triage status (issue #1390), in the geometry of `RunStatusBadge`
 * (`components/runs/run-status-badge.tsx`): a dot and a label, the hue carrying the
 * state and the label — not the hue — carrying the meaning. The hover text is the
 * status's own description from `src/api/bug-reports.ts`, the same words the MCP
 * tools and the docs use.
 *
 * Hues are the documented status hues (`ai/DESIGN_SYSTEM.md` §1): `sky` for a report
 * nobody has looked at, red for a confirmed defect, violet for one that became an
 * issue, green for fixed, zinc for the closed ones. `environmental` is deliberately the
 * most muted of all — its cause is outside SWARM, so it is potentially not actionable,
 * and it must not compete with a confirmed defect for attention.
 */

interface BadgeConfig {
	text: string;
	classes: string;
	dotClass: string;
}

const STATUS_CONFIGS: Record<BugReportStatus, BadgeConfig> = {
	new: {
		text: 'New',
		classes: 'bg-sky-500/10 text-sky-400 border-sky-500/20',
		dotClass: 'bg-sky-400',
	},
	confirmed: {
		text: 'Confirmed',
		classes: 'bg-red-500/10 text-red-400 border-red-500/20',
		dotClass: 'bg-red-400',
	},
	environmental: {
		text: 'Environmental',
		classes: 'bg-transparent text-zinc-500 border-zinc-500/20',
		dotClass: 'bg-zinc-600',
	},
	duplicate: {
		text: 'Duplicate',
		classes: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
		dotClass: 'bg-zinc-400',
	},
	ticketed: {
		text: 'Ticketed',
		classes: 'bg-violet-500/10 text-violet-400 border-violet-500/20',
		dotClass: 'bg-violet-400',
	},
	resolved: {
		text: 'Resolved',
		classes: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
		dotClass: 'bg-emerald-400',
	},
	dismissed: {
		text: 'Dismissed',
		classes: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
		dotClass: 'bg-zinc-400',
	},
};

/** The label a status reads as — also the filter chips' wording. */
export function bugReportStatusLabel(status: BugReportStatus): string {
	return STATUS_CONFIGS[status].text;
}

/** The hover text for a status: its description, capitalized. */
export function bugReportStatusTitle(status: BugReportStatus): string {
	const description = BUG_REPORT_STATUS_DESCRIPTIONS[status];
	return description.charAt(0).toUpperCase() + description.slice(1);
}

function isKnownStatus(status: string): status is BugReportStatus {
	return Object.hasOwn(STATUS_CONFIGS, status);
}

interface BugReportStatusBadgeProps extends ComponentProps<'span'> {
	/** A row's stored status; one this build does not know renders as itself, in zinc. */
	status: string;
}

export function BugReportStatusBadge({
	status,
	className = '',
	...props
}: BugReportStatusBadgeProps) {
	const config = isKnownStatus(status)
		? STATUS_CONFIGS[status]
		: {
				text: status,
				classes: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
				dotClass: 'bg-zinc-400',
			};
	return (
		<span
			title={isKnownStatus(status) ? bugReportStatusTitle(status) : undefined}
			className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-semibold border ${config.classes} ${className}`}
			{...props}
		>
			<span className={`h-1.5 w-1.5 rounded-full ${config.dotClass}`} />
			{config.text}
		</span>
	);
}
