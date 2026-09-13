/**
 * Answer the daemon module with a source that throws, and delegate every other module
 * to the rest of the chain (tsx, which compiles this repo's TypeScript). The injected
 * source is plain JavaScript, so it behaves the same whether this hook runs before or
 * after tsx's own.
 */
export async function load(url, context, nextLoad) {
	if (!/\/transport\/worker-main\.(?:ts|js)$/.test(url)) return nextLoad(url, context);
	return {
		format: 'module',
		shortCircuit: true,
		source: "throw new Error('poisoned worker-main: this build dies while ESM loads the daemon');",
	};
}
