/**
 * The dashboard's one on/off switch, shared by every screen that has a boolean to
 * flip: the Agent Configuration phase toggles it was extracted from
 * (`routes/projects/$projectId.tsx`) and the Workers screen's Available column.
 * One component, so a switch reads and behaves identically wherever it appears.
 *
 * It always calls `stopPropagation`: a switch commonly sits in a row that
 * navigates on click (`ai/DESIGN_SYSTEM.md` — a trailing row action must not
 * trigger the row), and a row that doesn't navigate is unaffected.
 */
export function ToggleSwitch({
	checked,
	label,
	disabled,
	title,
	onChange,
}: {
	checked: boolean;
	/** Accessible name — what the switch controls, not its current state. */
	label: string;
	disabled: boolean;
	/** Hover explanation, e.g. why a switch is shown but not operable. */
	title?: string;
	onChange?: () => void;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			title={title}
			disabled={disabled}
			onClick={(e) => {
				e.stopPropagation();
				onChange?.();
			}}
			className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-violet-500 focus:ring-offset-1 focus:ring-offset-[#0F0F11] disabled:opacity-50 disabled:cursor-not-allowed ${checked ? 'bg-violet-600' : 'bg-zinc-700'}`}
		>
			<span
				className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4' : 'translate-x-0.5'}`}
			/>
		</button>
	);
}
