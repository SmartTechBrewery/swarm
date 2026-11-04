/**
 * The **worker runtime manifest**: the wire contract by which a control plane
 * tells a worker host which packaged runtime to run and where to get it (issue
 * #1280, the third step of #1276).
 *
 * The installation serves the runtime for its **own** build, the one baked into its
 * image at `/app/worker-runtime/` (issue #1290), from two routes on the router
 * (`../router/worker-runtime.ts`):
 *
 *   - `GET /worker/runtime/manifest` — **unauthenticated**. A first install has no
 *     credential yet and still needs the version, checksum and signature. Nothing
 *     here is secret: a version, a commit, a SHA-256 and a public signature.
 *   - `GET /worker/runtime/artifacts/<name>` — **Bearer**: a worker credential or
 *     an operator session token (`swarm login`). The tarball is the installation's
 *     code, so a private fork's must not be downloadable by anyone who finds the URL.
 *
 * Both outcomes of the manifest are HTTP 200; a 404 means a control plane that
 * predates the route. `version` is the version the installation wants workers on —
 * today always its own, but the shape lets a later issue name another (a staged
 * rollout or a rollback), and `artifact.url` is resolved against the control-plane
 * URL (`new URL(url, controlPlaneUrl)`), so it may be relative (served here) or
 * absolute (served elsewhere).
 *
 * The control plane checks the checksum and the signature's trusted comment, not
 * the signature itself: the worker verifies `signature.minisig` against the public
 * key it trusts, which is the only check that means anything to it.
 *
 * No `node:` imports: the worker-side launcher bundles this module.
 */

import { z } from 'zod';

/** The unauthenticated manifest route. */
export const WORKER_RUNTIME_MANIFEST_PATH = '/worker/runtime/manifest';

/** The prefix the artifact route serves `<name>` under. Bearer-authenticated. */
export const WORKER_RUNTIME_ARTIFACTS_PATH = '/worker/runtime/artifacts';

const CommitSchema = z
	.string()
	.trim()
	.toLowerCase()
	.pipe(z.string().regex(/^[0-9a-f]{7,64}$/, 'must be a hex commit id'));

/** The runtime is served: what it is, how to check it, and where to download it. */
export const AvailableWorkerRuntimeManifestSchema = z.object({
	available: z.literal(true),
	version: z.string().min(1),
	commit: CommitSchema,
	artifact: z.object({
		name: z.string().min(1),
		/** Resolved against the control-plane URL; relative or absolute. */
		url: z.string().min(1),
		size: z.number().int().nonnegative(),
		sha256: z.string().regex(/^[0-9a-f]{64}$/, 'must be a hex SHA-256'),
	}),
	signature: z.object({
		format: z.literal('minisign'),
		/** The whole `.minisig` file, trusted comment included. */
		minisig: z.string().min(1),
	}),
});
export type AvailableWorkerRuntimeManifest = z.infer<typeof AvailableWorkerRuntimeManifestSchema>;

/** The installation serves no runtime, and says why. */
export const UnavailableWorkerRuntimeManifestSchema = z.object({
	available: z.literal(false),
	reason: z.string().min(1),
});

export const WorkerRuntimeManifestSchema = z.discriminatedUnion('available', [
	AvailableWorkerRuntimeManifestSchema,
	UnavailableWorkerRuntimeManifestSchema,
]);
export type WorkerRuntimeManifest = z.infer<typeof WorkerRuntimeManifestSchema>;

/** The artifact's file name for `version`, as `bin/build-worker-runtime.js` writes it. */
export function runtimeArtifactName(version: string): string {
	return `swarm-worker-runtime-${version}.tar.gz`;
}

const TRUSTED_COMMENT = /^trusted comment: swarm-worker-runtime (\S+) ([0-9a-f]{7,64})$/;

/**
 * The version and commit a runtime's `.minisig` trusted comment names
 * (`swarm-worker-runtime <version> <commit>`, written by
 * `.github/workflows/publish-image.yml`), or `undefined` when it names neither.
 * Reading it does not verify it: only a signature check against the public key
 * proves the comment is the publisher's.
 */
export function parseMinisignTrustedComment(
	minisig: string,
): { version: string; commit: string } | undefined {
	for (const line of minisig.split(/\r?\n/)) {
		const match = TRUSTED_COMMENT.exec(line.trim());
		if (match) return { version: match[1], commit: match[2] };
	}
	return undefined;
}
