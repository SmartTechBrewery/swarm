/**
 * The PM integrations barrel — one import for everything shared code needs to
 * work with PM providers *through the registry* rather than by naming one
 * (ai/CODING_STANDARDS.md "Module shape for a provider").
 *
 * Re-exports only the category's shared surface: the manifest contract, the
 * registry lookups, and the `PMRouterAdapter` interface a manifest's
 * `routerAdapter` satisfies. It deliberately does **not** re-export any provider
 * folder — importing this must never pull a concrete provider into a caller's
 * module graph. Registration still happens through the single canonical
 * entrypoint (`src/integrations/entrypoint.js`), which is a side-effect import.
 *
 * Importing `./registry.js` directly is equally correct and several call sites do;
 * this barrel exists so a caller that wants the whole category surface (contract +
 * lookups) takes one import rather than three.
 */

export type { PMRouterAdapter } from '../../pm/router-adapter.js';
export type {
	PMProviderManifest,
	PmWebhookVerification,
	PmWebhookVerifier,
} from './manifest.js';
export {
	getPMProvider,
	listPMProviders,
	registerPMProvider,
	requireProjectPMAdapter,
	requireProjectPMProvider,
} from './registry.js';
