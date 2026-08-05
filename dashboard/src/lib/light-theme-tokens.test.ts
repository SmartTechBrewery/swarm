import { globSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const DASHBOARD_ROOT = resolve(process.cwd());
const LIGHT_THEME = readFileSync(resolve(DASHBOARD_ROOT, 'src/index.css'), 'utf8').match(
	/\[data-theme="light"\] \{([\s\S]*?)\n\}/,
);
const STATUS_COLOR_CLASS =
	/\b(?:bg|text|border)-(red|orange|amber|emerald|sky|blue|violet)-(\d{3})(?:\/\d+)?\b/g;

describe('light-theme status tokens', () => {
	it('overrides every non-solid status shade used by dashboard components', () => {
		expect(LIGHT_THEME).not.toBeNull();
		const lightThemeTokens = LIGHT_THEME?.[1] ?? '';
		const requiredTokens = new Set<string>();

		for (const file of globSync('src/**/*.tsx', { cwd: DASHBOARD_ROOT })) {
			const source = readFileSync(resolve(DASHBOARD_ROOT, file), 'utf8');
			for (const match of source.matchAll(STATUS_COLOR_CLASS)) {
				const [className, _hue, shade] = match;
				if (shade !== '500' && shade !== '600') requiredTokens.add(className.split('/')[0]);
			}
		}

		for (const token of requiredTokens) {
			expect(lightThemeTokens).toContain(`--color-${token.replace(/^(bg|text|border)-/, '')}:`);
		}
	});
});
