import { closeDb } from '../../db/client.js';
import { cancelAllWaitingWork } from '../../dispatch/dispatcher.js';
import { closeQueue } from '../../queue/producer.js';
import * as out from '../_shared/output.js';

const USAGE = `swarm queue — inspect and clear pending queue work

Usage: swarm queue clear

  clear  Cancel every waiting dispatch (pending, event-blocked, and
         retry-scheduled — the canonical durable queue, issue #284) and drain
         their queued wake-ups plus any legacy jobs from Redis. Cancelled
         dispatches can never be resurrected by a retry, slot release, or
         reconciliation. Active (running) work is not touched; stop the worker
         first if nothing should start while clearing.

Requires DATABASE_URL and REDIS_URL in the environment — run via
\`npm run queue:clear\` (loads .env) or export them yourself first.`;

export async function run(argv: string[]): Promise<number> {
	const [subcommand, ...rest] = argv;

	if (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
		out.info(USAGE);
		return subcommand ? 0 : 1;
	}

	if (subcommand !== 'clear' || rest.length > 0) {
		out.error(`unknown queue subcommand '${[subcommand, ...rest].join(' ')}'`);
		out.info(USAGE);
		return 1;
	}

	try {
		const { cancelledDispatches, removedJobs } = await cancelAllWaitingWork(
			'Cancelled by `swarm queue clear`',
		);
		out.info(
			`cancelled ${cancelledDispatches} waiting dispatch${cancelledDispatches === 1 ? '' : 'es'}, ` +
				`removed ${removedJobs} queued job${removedJobs === 1 ? '' : 's'}`,
		);
		return 0;
	} catch (err) {
		out.error(`queue clear failed: ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	} finally {
		await closeQueue();
		await closeDb();
	}
}
