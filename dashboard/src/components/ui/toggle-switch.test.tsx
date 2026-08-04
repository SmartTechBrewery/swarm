// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ToggleSwitch } from './toggle-switch.js';

// The shared on/off switch, extracted from the Agent Configuration phase toggles
// so the Workers screen's Available column renders the same control. These cases
// moved with it from `routes/projects/$projectId.test.tsx`.
describe('ToggleSwitch', () => {
	it('renders as a switch with the correct accessible label and state', () => {
		render(<ToggleSwitch checked={true} label="Test label" disabled={false} onChange={() => {}} />);

		const switchElement = screen.getByRole('switch') as HTMLButtonElement;
		expect(switchElement).toBeDefined();
		expect(switchElement.getAttribute('aria-checked')).toBe('true');
		expect(switchElement.getAttribute('aria-label')).toBe('Test label');
		expect(switchElement.disabled).toBe(false);
	});

	it('respects the disabled prop', () => {
		render(<ToggleSwitch checked={false} label="Test label" disabled={true} onChange={() => {}} />);

		const switchElement = screen.getByRole('switch') as HTMLButtonElement;
		expect(switchElement.disabled).toBe(true);
		expect(switchElement.getAttribute('aria-checked')).toBe('false');
	});

	it('triggers onChange and stops propagation when clicked', () => {
		const handleChange = vi.fn();

		render(
			<ToggleSwitch checked={false} label="Test label" disabled={false} onChange={handleChange} />,
		);

		const switchElement = screen.getByRole('switch') as HTMLButtonElement;
		const event = new MouseEvent('click', { bubbles: true, cancelable: true });
		const stopPropagationSpy = vi.spyOn(event, 'stopPropagation');

		fireEvent(switchElement, event);

		expect(handleChange).toHaveBeenCalledTimes(1);
		expect(stopPropagationSpy).toHaveBeenCalledTimes(1);
	});

	it('carries an optional hover explanation for a state shown without a control', () => {
		render(
			<ToggleSwitch
				checked={true}
				label="Sharing of ada-laptop with Widgets"
				title="Only Ada Lovelace can change sharing for Widgets"
				disabled={true}
			/>,
		);

		expect(screen.getByRole('switch').getAttribute('title')).toBe(
			'Only Ada Lovelace can change sharing for Widgets',
		);
	});
});
