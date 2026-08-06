import { useEffect, useRef, useState } from 'react';

/**
 * A local edit buffer that resyncs from the server value only when that value
 * actually changes — never on every render/poll — so a half-typed edit
 * survives the screen's background polling. Shared by every draft-and-save
 * control (worker rename, enrollment concurrency) that can't safely fire a
 * mutation on every keystroke.
 */
export function useDraftSync<TValue, TDraft>(
	serverValue: TValue,
	toDraft: (value: TValue) => TDraft,
) {
	const [draft, setDraft] = useState(() => toDraft(serverValue));
	const lastServerValue = useRef(serverValue);
	useEffect(() => {
		if (lastServerValue.current !== serverValue) {
			lastServerValue.current = serverValue;
			setDraft(toDraft(serverValue));
		}
	}, [serverValue, toDraft]);
	return [draft, setDraft] as const;
}
