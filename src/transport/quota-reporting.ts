/**
 * Worker-side CLI quota reporting (issue #825, phase 2 of #823) — the writer that
 * makes the CLI Quotas page correct now that a `cli_quotas` row belongs to a
 * *worker*.
 *
 * The daemon is the only process that can produce that row: a snapshot describes
 * one machine's installed CLIs and logins, and the control plane is nobody's
 * worker (which is why phase 1 removed its own probe rather than re-pointing it).
 * So this module probes **this** host and POSTs the snapshots to
 * `POST /worker/delivery/quota`, where the router persists each one against the
 * worker the credential authenticated as (`../router/worker-delivery.ts`).
 *
 * **Best-effort throughout.** A failed probe or a refused POST is one `warn` line
 * and nothing else — it never ends the session, fails a phase, or stops the
 * daemon. That includes running against an *older* control plane which does not
 * serve the route: `postDelivery` turns the 404 into a one-line explanation
 * (`./delivery-client.ts`) and the loop simply tries again next interval.
 *
 * **One limitation, stated rather than papered over:** a worker-reported snapshot
 * carries no run-derived exhaustion hint. `getFallbackRateLimitInfo` reads
 * `runs.next_retry_at` from Postgres and this process holds no `DATABASE_URL`, so
 * discovery is given a resolver that answers `null` ({@link NO_RUN_DERIVED_FALLBACK})
 * and reports live data or none. Enriching that server-side would need the lookup
 * scoped per worker, which is its own change.
 */

import type { CliQuotaSnapshot } from '../harness/quota.js';
import { discoverCliQuotas } from '../harness/quota-discovery.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { postDelivery } from './delivery-client.js';
import {
	type ReportCliQuotaDeliveryResponse,
	ReportCliQuotaDeliveryResponseSchema,
} from './protocol.js';

/**
 * How often a connected daemon re-reports its host's allowance. Coded rather than
 * configurable, carried over verbatim from the retired control-plane loop's
 * `QUOTA_DISCOVERY_INTERVAL_MS` (`../api/maintenance.ts`, issue #550), so
 * `docs/configuration.md` gains no row.
 */
export const WORKER_QUOTA_REPORT_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** The route this daemon reports to. */
const QUOTA_DELIVERY_PATH = '/worker/delivery/quota';

/**
 * The run-derived exhaustion lookup a DB-free worker can make: none. Passed into
 * discovery so nothing on this path reaches for Postgres (see the module comment).
 */
const NO_RUN_DERIVED_FALLBACK = async () => null;

/** What the reporter needs to probe this host and reach the control plane. */
export interface WorkerQuotaReportingOptions {
	/** Base URL of the control-plane delivery API. */
	controlPlaneUrl: string;
	/** Raw registered-worker credential — the only thing that names the reporting worker. */
	workerCredential: string;
	/** Probe this host's CLIs; defaults to the real discovery. Injected in tests. */
	discover?: typeof discoverCliQuotas;
	/** Deliver one report; defaults to a `postDelivery` call. Injected in tests. */
	post?: (snapshots: CliQuotaSnapshot[]) => Promise<ReportCliQuotaDeliveryResponse>;
	/** Report cadence; defaults to {@link WORKER_QUOTA_REPORT_INTERVAL_MS}. */
	intervalMs?: number;
}

/** A running reporter — stopped on every daemon exit path. */
export interface WorkerQuotaReportingHandle {
	stop: () => void;
}

/**
 * Start reporting this host's CLI quota to the control plane.
 *
 * The cadence matches the loop this replaces: one **full** probe shortly after
 * startup, so a freshly connected worker's card is live rather than empty, then a
 * **cheap** probe on the interval — a live probe spawns each CLI, which is not
 * something to do every few minutes in the background. The interval is `unref`'d,
 * so reporting never keeps the daemon alive; nothing is awaited here, so the
 * caller's own startup is not held up by a CLI spawn.
 */
export function startWorkerQuotaReporting(
	options: WorkerQuotaReportingOptions,
): WorkerQuotaReportingHandle {
	const discover = options.discover ?? discoverCliQuotas;
	const post =
		options.post ??
		((snapshots: CliQuotaSnapshot[]) =>
			postDelivery(
				{
					controlPlaneUrl: options.controlPlaneUrl,
					workerCredential: options.workerCredential,
				},
				QUOTA_DELIVERY_PATH,
				{ snapshots },
				ReportCliQuotaDeliveryResponseSchema.parse,
			));
	const intervalMs = options.intervalMs ?? WORKER_QUOTA_REPORT_INTERVAL_MS;

	/** One probe-and-report. Swallows everything: reporting is not the daemon's job. */
	async function reportOnce(cheap: boolean): Promise<void> {
		try {
			const snapshots = await discover(cheap, { fallbackRateLimitInfo: NO_RUN_DERIVED_FALLBACK });
			const { stored } = await post(snapshots);
			logger.debug('reported this host CLI quota to the control plane', { cheap, stored });
		} catch (err) {
			logger.warn('reporting this host CLI quota failed', { cheap, error: describeError(err) });
		}
	}

	void reportOnce(false);

	const timer = setInterval(() => {
		void reportOnce(true);
	}, intervalMs);
	timer.unref();

	return {
		stop: () => {
			clearInterval(timer);
		},
	};
}
