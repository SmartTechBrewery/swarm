/**
 * The **operator** tRPC router (issue #799) — a deliberate strict subset of
 * `./router.ts`'s `appRouter`, served from the control-plane *router* process at
 * `/operator/trpc/*` (`../router/operator-api.ts`) and authenticated by the
 * bearer token `swarm login` mints (issue #798).
 *
 * **Why a second router instead of mounting `appRouter` there.** The API server
 * binds `127.0.0.1`; the router is the process `SWARM_CONTROL_PLANE_URL` points
 * at, which on a real installation is fronted by a Cloudflare tunnel and so is
 * internet-reachable (`docs/cloudflare-tunnel.md`). Everything mounted on it is
 * therefore exposed, and only what an operator CLI genuinely needs over the
 * network belongs there. `swarm workers` is that need (issue #796 is scoped to it
 * alone), so this router carries the workers namespace and nothing else —
 * projects, credentials, settings, users and runs stay off the exposed process
 * entirely rather than relying on their own authorization as the only barrier.
 *
 * It re-exports `workersRouter` **verbatim**: every procedure keeps the exact
 * authorization it has on the dashboard (`assertInstanceAdmin` for the
 * installation roster, strict ownership for the machine-owner mutations,
 * `assertProjectAccess` for the project roster). Nothing is relaxed for being
 * reached over the network, and a caller here is an ordinary `SwarmUser` resolved
 * from a real `user_sessions` row — not a privileged service identity.
 *
 * Widening this router is a deliberate act: adding a namespace here publishes it,
 * so it wants its own issue and its own reasoning, not a convenience import.
 */

// Side-effect import: registers every PM and SCM provider manifest, exactly as
// `./router.ts` does for the dashboard's router. `workers.projectScmProvider`
// resolves a project's provider out of that registry at request time, so this
// module must not rely on a sibling having loaded the entrypoint first.
import '../integrations/entrypoint.js';
import { workersRouter } from './routers/workers.js';
import { router } from './trpc.js';

export const operatorRouter = router({
	workers: workersRouter,
});

export type OperatorRouter = typeof operatorRouter;
