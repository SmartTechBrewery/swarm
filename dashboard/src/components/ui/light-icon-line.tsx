import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * A line of *secondary* information under a primary label (issue #1365): an optional
 * small leading icon before `text-xs` text, both in the muted ink colour at the
 * regular weight. Adapted from `under-control-platform`'s `LightIconLine`; "muted
 * ink" here is the dashboard's existing secondary-text colour, `text-zinc-500`, which
 * the light theme remaps in `index.css`, so the line reads in both themes without a
 * token of its own.
 *
 * The icon is decorative (`aria-hidden`) — the visible text is what a screen reader
 * reads — and sits at the compact icon size (`size-3.5`, `ai/DESIGN_SYSTEM.md`),
 * vertically centred on the text's *first* line rather than on the whole block, so
 * it stays put when the text wraps. Links inside the text are underlined, since a
 * muted line gives them no colour to stand out by.
 *
 * `truncate` keeps a long value on one line, cut with an ellipsis; pair it with
 * `title` so the full value stays available on hover.
 */
export function LightIconLine({
	icon: Icon,
	children,
	as: Tag = 'p',
	id,
	className,
	title,
	truncate = false,
	'data-testid': testId,
}: {
	icon?: LucideIcon;
	children: ReactNode;
	as?: 'p' | 'span';
	id?: string;
	className?: string;
	title?: string;
	truncate?: boolean;
	'data-testid'?: string;
}) {
	return (
		<Tag
			id={id}
			title={title}
			data-testid={testId}
			className={`flex items-start gap-1.5 text-xs font-normal text-zinc-500 [&_a]:underline ${className ?? ''}`}
		>
			{Icon ? (
				<Icon aria-hidden="true" className="mt-[calc((1lh-0.875rem)/2)] size-3.5 shrink-0" />
			) : null}
			<span className={truncate ? 'min-w-0 truncate' : 'min-w-0'}>{children}</span>
		</Tag>
	);
}
