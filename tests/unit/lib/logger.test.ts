import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { configureLogger, logger } from '@/lib/logger.js';

// The logger maps each level to its matching console method (debug→console.log,
// info→console.info, warn→console.warn, error→console.error); capture all four
// to assert on the emitted line.
let logSpy: MockInstance;
let infoSpy: MockInstance;
let warnSpy: MockInstance;
let errorSpy: MockInstance;

beforeEach(() => {
	logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
	warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
	errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	// Default to a deterministic format/level for each test; individual tests
	// override via vi.stubEnv. Reset the process-wide base context too.
	vi.stubEnv('SWARM_LOG_FORMAT', 'json');
	vi.stubEnv('SWARM_LOG_LEVEL', 'debug');
	configureLogger({});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe('json format', () => {
	it('emits one JSON object per line with level, time, msg and context', () => {
		logger.info('hello', { taskId: 't-1' });

		expect(infoSpy).toHaveBeenCalledTimes(1);
		const parsed = JSON.parse(infoSpy.mock.calls[0][0] as string);
		expect(parsed).toMatchObject({ level: 'info', msg: 'hello', taskId: 't-1' });
		expect(typeof parsed.time).toBe('string');
		expect(() => new Date(parsed.time).toISOString()).not.toThrow();
	});

	it('emits a well-formed line when no context is passed', () => {
		logger.warn('careful');

		const parsed = JSON.parse(warnSpy.mock.calls[0][0] as string);
		expect(parsed).toMatchObject({ level: 'warn', msg: 'careful' });
	});

	it('routes debug through console.log and error through console.error', () => {
		logger.debug('d');
		logger.error('e');

		expect(JSON.parse(logSpy.mock.calls[0][0] as string).level).toBe('debug');
		expect(JSON.parse(errorSpy.mock.calls[0][0] as string).level).toBe('error');
	});
});

describe('level filtering', () => {
	it('drops calls below SWARM_LOG_LEVEL', () => {
		vi.stubEnv('SWARM_LOG_LEVEL', 'warn');

		logger.debug('d');
		logger.info('i');
		logger.warn('w');
		logger.error('e');

		expect(logSpy).not.toHaveBeenCalled(); // debug suppressed
		expect(infoSpy).not.toHaveBeenCalled(); // info suppressed
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(errorSpy).toHaveBeenCalledTimes(1);
	});

	it('defaults to info when SWARM_LOG_LEVEL is unset or invalid', () => {
		vi.stubEnv('SWARM_LOG_LEVEL', 'nonsense');

		logger.debug('d');
		logger.info('i');

		expect(logSpy).not.toHaveBeenCalled(); // debug dropped at the info default
		expect(infoSpy).toHaveBeenCalledTimes(1);
		expect(JSON.parse(infoSpy.mock.calls[0][0] as string).msg).toBe('i');
	});
});

describe('pretty format', () => {
	beforeEach(() => {
		vi.stubEnv('SWARM_LOG_FORMAT', 'pretty');
		// Isolate format from color: these tests assert on plain text regardless
		// of whether the test runner's own stdout happens to be a TTY.
		vi.stubEnv('NO_COLOR', '1');
	});

	it('renders a clock, level tag, message, and key=value context', () => {
		logger.info('listening', { port: 3000 });

		expect(infoSpy.mock.calls[0][0]).toMatch(/^\d{2}:\d{2}:\d{2} INFO {2}listening port=3000$/);
	});

	it('omits the context tail when there is nothing to show', () => {
		logger.info('ready');

		expect(infoSpy.mock.calls[0][0]).toMatch(/^\d{2}:\d{2}:\d{2} INFO {2}ready$/);
	});

	it('renders the bound component as a [component] prefix, not a trailing key=value', () => {
		configureLogger({ component: 'worker' });

		logger.info('job done', { jobId: 'j-9' });

		expect(infoSpy.mock.calls[0][0]).toMatch(
			/^\d{2}:\d{2}:\d{2} INFO {2}\[worker\] job done jobId=j-9$/,
		);
	});

	it('quotes a context value that contains whitespace', () => {
		logger.info('msg', { note: 'two words' });

		expect(infoSpy.mock.calls[0][0]).toContain('note="two words"');
	});

	it('drops an undefined context value instead of printing key=undefined', () => {
		logger.info('msg', { movedTo: undefined, taskId: '5' });

		const line = infoSpy.mock.calls[0][0] as string;
		expect(line).toContain('taskId=5');
		expect(line).not.toContain('movedTo');
	});

	it('inlines a nested object value as compact JSON', () => {
		logger.info('msg', { outcome: { status: 'ok', code: 0 } });

		expect(infoSpy.mock.calls[0][0]).toContain('outcome={"status":"ok","code":0}');
	});
});

describe('pretty format color', () => {
	let originalIsTTY: boolean | undefined;

	beforeEach(() => {
		originalIsTTY = process.stdout.isTTY;
		vi.stubEnv('SWARM_LOG_FORMAT', 'pretty');
		vi.stubEnv('NO_COLOR', '');
		Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
	});

	afterEach(() => {
		Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
	});

	it('colors the level tag on a real TTY', () => {
		logger.error('boom');

		expect(errorSpy.mock.calls[0][0]).toContain('\x1b[31m');
	});

	it('suppresses color entirely when NO_COLOR is set', () => {
		vi.stubEnv('NO_COLOR', '1');

		logger.error('boom');

		expect(errorSpy.mock.calls[0][0]).not.toContain('\x1b[');
	});

	it('suppresses color when stdout is not a TTY, even with SWARM_LOG_FORMAT=pretty', () => {
		Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

		logger.error('boom');

		expect(errorSpy.mock.calls[0][0]).not.toContain('\x1b[');
	});
});

describe('crash-safety against un-serializable context', () => {
	it('coerces a BigInt to a string rather than throwing', () => {
		expect(() => logger.info('big', { amount: 9007199254740993n })).not.toThrow();

		const parsed = JSON.parse(infoSpy.mock.calls[0][0] as string);
		expect(parsed).toMatchObject({ msg: 'big', amount: '9007199254740993' });
	});

	it('emits a _logError line instead of throwing on a circular reference', () => {
		const circular: Record<string, unknown> = { name: 'loop' };
		circular.self = circular;

		expect(() => logger.error('cycle', circular)).not.toThrow();

		const parsed = JSON.parse(errorSpy.mock.calls[0][0] as string);
		expect(parsed).toMatchObject({ level: 'error', msg: 'cycle' });
		expect(typeof parsed._logError).toBe('string');
	});

	it('degrades gracefully in pretty format too', () => {
		vi.stubEnv('SWARM_LOG_FORMAT', 'pretty');
		const circular: Record<string, unknown> = {};
		circular.self = circular;

		expect(() => logger.warn('cycle', circular)).not.toThrow();

		const line = warnSpy.mock.calls[0][0] as string;
		expect(line).toContain('[warn] cycle');
		expect(line).toContain('_logError');
	});
});

describe('format auto-detection when SWARM_LOG_FORMAT is unset', () => {
	// resolveFormat falls back to process.stdout.isTTY when no explicit format
	// is set — the default production path that every other test bypasses by
	// stubbing the env. Stub isTTY around each case and restore it after.
	let originalIsTTY: boolean | undefined;

	beforeEach(() => {
		originalIsTTY = process.stdout.isTTY;
		vi.stubEnv('SWARM_LOG_FORMAT', undefined);
	});

	afterEach(() => {
		Object.defineProperty(process.stdout, 'isTTY', {
			value: originalIsTTY,
			configurable: true,
		});
	});

	it('renders pretty on an interactive terminal', () => {
		vi.stubEnv('NO_COLOR', '1'); // isolate format-detection from color
		Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

		logger.info('hi', { port: 3000 });

		expect(infoSpy.mock.calls[0][0]).toMatch(/^\d{2}:\d{2}:\d{2} INFO {2}hi port=3000$/);
	});

	it('renders json when stdout is piped/containerized', () => {
		Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

		logger.info('hi', { port: 3000 });

		expect(JSON.parse(infoSpy.mock.calls[0][0] as string)).toMatchObject({
			level: 'info',
			msg: 'hi',
			port: 3000,
		});
	});

	it('falls through to auto-detect for an unrecognized format value', () => {
		vi.stubEnv('SWARM_LOG_FORMAT', 'yaml');
		vi.stubEnv('NO_COLOR', '1'); // isolate format-detection from color
		Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

		logger.info('hi');

		expect(infoSpy.mock.calls[0][0]).toMatch(/^\d{2}:\d{2}:\d{2} INFO {2}hi$/);
	});
});

describe('file sink', () => {
	// The sink is module-level state (one stream per process), so each test
	// re-imports the logger fresh via resetModules to get a clean, unopened sink.
	beforeEach(() => {
		vi.resetModules();
		vi.stubEnv('SWARM_LOG_FORMAT', 'json');
		vi.stubEnv('SWARM_LOG_LEVEL', 'debug');
	});

	// Poll the file until the expected number of lines have flushed — a
	// WriteStream write is buffered and lands on a later tick, so a bare read
	// right after the log call races the flush.
	async function readLines(path: string, expected: number): Promise<string[]> {
		for (let attempt = 0; attempt < 50; attempt++) {
			try {
				const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
				if (lines.length >= expected) return lines;
			} catch {
				// file not created yet
			}
			await new Promise((r) => setTimeout(r, 5));
		}
		throw new Error(`file ${path} did not reach ${expected} line(s) in time`);
	}

	it('appends each emitted line to the file as JSON, regardless of console format', async () => {
		vi.stubEnv('SWARM_LOG_FORMAT', 'pretty'); // console pretty, but the file must stay JSON
		const path = join(mkdtempSync(join(tmpdir(), 'swarm-log-')), 'worker.log');
		const { addFileSink, configureLogger: cfg, logger: log } = await import('@/lib/logger.js');
		cfg({ component: 'worker' });

		addFileSink(path);
		log.info('to file', { taskId: 't-1' });

		const [line] = await readLines(path, 1);
		expect(JSON.parse(line)).toMatchObject({
			level: 'info',
			msg: 'to file',
			taskId: 't-1',
			component: 'worker',
		});
	});

	it('respects the level filter — a dropped console line is not written to the file', async () => {
		vi.stubEnv('SWARM_LOG_LEVEL', 'warn');
		const path = join(mkdtempSync(join(tmpdir(), 'swarm-log-')), 'worker.log');
		const { addFileSink, logger: log } = await import('@/lib/logger.js');

		addFileSink(path);
		log.info('suppressed');
		log.warn('kept');

		const lines = await readLines(path, 1);
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]).msg).toBe('kept');
	});

	it('is idempotent — a second addFileSink call does not redirect the sink', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'swarm-log-'));
		const first = join(dir, 'first.log');
		const second = join(dir, 'second.log');
		const { addFileSink, logger: log } = await import('@/lib/logger.js');

		addFileSink(first);
		addFileSink(second); // ignored — first sink wins
		log.info('once');

		const [line] = await readLines(first, 1);
		expect(JSON.parse(line).msg).toBe('once');
		expect(() => readFileSync(second, 'utf8')).toThrow(); // never created
	});
});

describe('configureLogger base context', () => {
	it('merges the process-wide context into every line', () => {
		configureLogger({ component: 'worker' });

		logger.info('job done', { jobId: 'j-9' });

		expect(JSON.parse(infoSpy.mock.calls[0][0] as string)).toMatchObject({
			component: 'worker',
			jobId: 'j-9',
		});
	});

	it('lets call-site context override the base context', () => {
		configureLogger({ component: 'worker' });

		logger.info('override', { component: 'pipeline' });

		expect(JSON.parse(infoSpy.mock.calls[0][0] as string).component).toBe('pipeline');
	});

	it('replaces rather than accumulates base context', () => {
		configureLogger({ component: 'router' });
		configureLogger({ component: 'worker' });

		logger.info('x');

		expect(JSON.parse(infoSpy.mock.calls[0][0] as string).component).toBe('worker');
	});
});

// Issue #1343 — the in-memory window the operator MCP server's
// `control_plane_logs` tool reads.
describe('log ring buffer', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	async function freshLogger() {
		return import('@/lib/logger.js');
	}

	it('is off by default: nothing is buffered until a process enables it', async () => {
		const { logger: log, queryLogRingBuffer } = await freshLogger();

		log.info('not kept', { projectId: 'p1' });

		expect(queryLogRingBuffer()).toEqual({ entries: [], capacity: 0, size: 0, oldestTime: null });
	});

	it('keeps the json object as time, level, msg and merged context, newest first', async () => {
		const {
			configureLogger: cfg,
			enableLogRingBuffer,
			logger: log,
			queryLogRingBuffer,
		} = await freshLogger();
		cfg({ component: 'router' });
		enableLogRingBuffer(10);

		log.info('first', { projectId: 'p1', taskId: '7' });
		log.warn('second');

		const { entries, capacity, size, oldestTime } = queryLogRingBuffer();
		expect(entries.map((entry) => entry.msg)).toEqual(['second', 'first']);
		expect(entries[1]).toEqual({
			time: oldestTime,
			level: 'info',
			msg: 'first',
			context: { component: 'router', projectId: 'p1', taskId: '7' },
		});
		expect({ capacity, size }).toEqual({ capacity: 10, size: 2 });
	});

	it('evicts the oldest line once full', async () => {
		const { enableLogRingBuffer, logger: log, queryLogRingBuffer } = await freshLogger();
		enableLogRingBuffer(3);

		for (const msg of ['a', 'b', 'c', 'd', 'e']) log.info(msg);

		const result = queryLogRingBuffer();
		expect(result.entries.map((entry) => entry.msg)).toEqual(['e', 'd', 'c']);
		expect(result.size).toBe(3);
	});

	it('filters on the correlation keys, comparing numbers and strings alike', async () => {
		const { enableLogRingBuffer, logger: log, queryLogRingBuffer } = await freshLogger();
		enableLogRingBuffer(10);

		log.info('a', { projectId: 'p1', taskId: '7', prNumber: 12, dispatchId: 'd1' });
		log.info('b', { projectId: 'p1', taskId: 7, prNumber: '13' });
		log.info('c', { projectId: 'p2', taskId: '7' });
		log.info('d');

		const msgs = (filter: Parameters<typeof queryLogRingBuffer>[0]) =>
			queryLogRingBuffer(filter).entries.map((entry) => entry.msg);
		expect(msgs({ projectId: 'p1' })).toEqual(['b', 'a']);
		expect(msgs({ taskId: '7' })).toEqual(['c', 'b', 'a']);
		expect(msgs({ projectId: 'p1', prNumber: 13 })).toEqual(['b']);
		expect(msgs({ dispatchId: 'd1' })).toEqual(['a']);
		expect(msgs({ projectId: 'p1', limit: 1 })).toEqual(['b']);
	});

	it('applies a minimum level and a since/until window', async () => {
		vi.useFakeTimers();
		try {
			const { enableLogRingBuffer, logger: log, queryLogRingBuffer } = await freshLogger();
			enableLogRingBuffer(10);
			vi.setSystemTime(new Date('2026-11-06T10:00:00Z'));
			log.debug('early debug');
			vi.setSystemTime(new Date('2026-11-06T11:00:00Z'));
			log.warn('mid warn');
			vi.setSystemTime(new Date('2026-11-06T12:00:00Z'));
			log.error('late error');

			const msgs = (filter: Parameters<typeof queryLogRingBuffer>[0]) =>
				queryLogRingBuffer(filter).entries.map((entry) => entry.msg);
			expect(msgs({ level: 'warn' })).toEqual(['late error', 'mid warn']);
			expect(
				msgs({ since: new Date('2026-11-06T11:00:00Z'), until: new Date('2026-11-06T12:00:00Z') }),
			).toEqual(['mid warn']);
		} finally {
			vi.useRealTimers();
		}
	});

	it('records only what passes SWARM_LOG_LEVEL', async () => {
		vi.stubEnv('SWARM_LOG_LEVEL', 'warn');
		const { enableLogRingBuffer, logger: log, queryLogRingBuffer } = await freshLogger();
		enableLogRingBuffer(10);

		log.info('dropped');
		log.warn('kept');

		expect(queryLogRingBuffer().entries.map((entry) => entry.msg)).toEqual(['kept']);
	});

	it('keeps an oversized line as its message head and correlation keys', async () => {
		const { enableLogRingBuffer, logger: log, queryLogRingBuffer } = await freshLogger();
		enableLogRingBuffer(10);

		log.error('huge', { projectId: 'p1', payload: 'x'.repeat(50_000) });

		const [entry] = queryLogRingBuffer({ projectId: 'p1' }).entries;
		expect(entry).toMatchObject({ msg: 'huge', context: { projectId: 'p1', _truncated: true } });
		expect(entry?.context).not.toHaveProperty('payload');
	});

	it('never throws into the caller over an unserializable context', async () => {
		const { enableLogRingBuffer, logger: log, queryLogRingBuffer } = await freshLogger();
		enableLogRingBuffer(10);
		const circular: Record<string, unknown> = {};
		circular.self = circular;

		expect(() => log.info('circular', { projectId: 'p1', circular })).not.toThrow();
		expect(queryLogRingBuffer({ projectId: 'p1' }).entries[0]?.msg).toBe('circular');
	});
});
