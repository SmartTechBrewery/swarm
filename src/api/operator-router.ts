/**
 * The **operator** tRPC router (issue #799) — a deliberate strict subset of
 * `./router.ts`'s `appRouter`, served from the control-plane *router* process at
 * `/operator/trpc/*` (`../router/operator-api.ts`) and authenticated by the
 * bearer token `swarm login` mints (issue #798).
 *
 * **Why a second router instead of mounting `appRouter` there.** The API server
 * binds `127.0.0.1`; the router is the process `SWARM_CONTROL_PLANE_URL` points
 * at, which on a real installation is fronted by a Cloudflare tunnel (or Caddy on
 * the VPS deploy) and so is internet-reachable (`docs/cloudflare-tunnel.md`).
 * Everything mounted on it is therefore exposed, and only what an operator CLI
 * genuinely needs over the network belongs there. It carries two namespaces:
 *
 * - `workers` (issue #799) — what `swarm workers` needs (issue #796).
 * - `runs`, **read-only** (issue #1182) — exactly `list`, `getById`, `getLogs`
 *   and `getOutput`, what `swarm run list|show|logs` needs. On an installation
 *   with no shell on the host (the VPS behind Caddy, issue #1153, reachable only
 *   through a restricted `dockerctl` wrapper) Postgres is unreachable and `docker
 *   logs` holds a few hundred lines, so diagnosing a failed run required a
 *   signed-in browser: it could not be scripted, done from a terminal, or done by
 *   an assistant session.
 *
 * Projects, credentials, settings and users stay off the exposed process
 * entirely rather than relying on their own authorization as the only barrier.
 * So do every run mutation (`retryNow`, `terminate`, `reset`, `forceReReview`,
 * `dismissStalled`, `putBack`) and the installation-wide dispatch views
 * (`queued`, `stalled`). No credential-bearing procedure is mounted, so nothing
 * the dashboard masks is reachable here.
 *
 * Both namespaces are the dashboard's **own procedure objects**, re-exported
 * verbatim: every procedure keeps the exact authorization it has on the dashboard
 * (`assertInstanceAdmin` for the installation roster, strict ownership for the
 * machine-owner mutations, `assertProjectAccess` for the project roster and for a
 * project-scoped run read; the membership-bounded cross-project run list, or the
 * unfiltered one for an `instanceAdmin`; the existence-hiding `NOT_FOUND` for a
 * run in a project the caller is not a member of). Nothing is relaxed for being
 * reached over the network, and a caller here is an ordinary `SwarmUser` resolved
 * from a real `user_sessions` row — not a privileged service identity. A bearer
 * caller reads exactly the runs the same user reads in the dashboard.
 *
 * Stated plainly, since it is the cost of #1182: on a split deployment the API
 * server is loopback-only, so mounting the run reads here makes them
 * network-reachable for the first time. The barrier is the same session plus the
 * same authorization the dashboard applies. A run's logs and agent output can
 * carry sensitive detail, exactly as the dashboard already shows them to a
 * project's contributors.
 *
 * Widening this router is a deliberate act: adding a namespace here publishes it,
 * so it wants its own issue and its own reasoning, not a convenience import.
 */

// Side-effect import: registers every PM and SCM provider manifest, exactly as
// `./router.ts` does for the dashboard's router. `workers.projectScmProvider`
// resolves a project's provider out of that registry at request time, so this
// module must not rely on a sibling having loaded the entrypoint first.
import '../integrations/entrypoint.js';
import { runsReadRouter } from './routers/runs.js';
import { workersRouter } from './routers/workers.js';
import { router } from './trpc.js';

export const operatorRouter = router({
	workers: workersRouter,
	runs: runsReadRouter,
});

export type OperatorRouter = typeof operatorRouter;
