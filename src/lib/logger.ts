/**
 * Structured logger — a dependency-free console wrapper mirroring the shape of
 * Cascade's `src/utils/logging.ts` (`logger.info/warn/error/debug` taking a
 * message plus a structured-context object) so code ported from Cascade reads
 * unchanged. Deliberately tiny: SWARM's MVP has no log-shipping requirement, so
 * this stays a wrapper rather than pulling in a logging framework (pino/winston).
 *
 * Two output formats: `json` emits one JSON object per line (`{level,time,msg,
 * ...context}`) for machine parsing/aggregation; `pretty` is for a human
 * watching a terminal — a wall-clock time, a colored level tag, the message,
 * then any remaining context as `key=value` pairs (colors only on a real TTY,
 * and never when `NO_COLOR` is set — https://no-color.org). Format and minimum
 * level are read from the environment per call, so the router and worker can
 * be tuned independently (see docker-compose.yml / README). `configureLogger`
 * binds a process-wide context (e.g. `{component: 'router'}`) onto every line;
 * pretty rendering pulls `component` out into a `[component]` prefix so a
 * shared log stream stays attributable to the process that produced it without
 * repeating `component=...` on every single line.
 *
 * An optional **file sink** (`addFileSink`) tees every emitted line to a file in
 * addition to the console — the worker enables it so a long unattended run
 * leaves a durable, greppable log behind rather than only scrolling past in a
 * terminal. The file always gets the `json` form regardless of the console
 * format, since a file is read back by tools/aggregators (and by an agent
 * grepping it later), not watched live.
 *
 * An optional in-memory **ring buffer** (`enableLogRingBuffer`) keeps the most
 * recent emitted lines queryable from inside the process (`queryLogRingBuffer`)
 * — the router enables it so the operator MCP server's `control_plane_logs` tool
 * can read the control plane's own recent logs without `docker logs` (issue
 * #1343). It holds the same object the `json` format emits, is bounded by a
 * fixed entry count, and starts empty on every restart: it is a window onto
 * recent activity, not a log store.
 */

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogContext = Record<string, unknown>;

// Numeric ordering mirrors Cascade's LOG_LEVELS: a call is emitted only when its
// level is >= the configured minimum.
const LEVEL_WEIGHT: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

// Merged into every line. Set once per process via configureLogger (the router
// and worker each bind their component); empty in unconfigured contexts (tests,
// one-off scripts).
let baseContext: LogContext = {};

/**
 * Bind a process-wide context onto every subsequent log line. Called once at
 * each entry point (router/worker) with `{component}`. Replaces the previous
 * base context rather than merging — each process has a single identity, and
 * replace semantics keep tests able to reset it.
 */
export function configureLogger(context: LogContext): void {
	baseContext = { ...context };
}

// The file sink, lazily opened by addFileSink. A single append stream per
// process; once it errors (disk full, bad path) it's marked failed and quietly
// skipped so a logging problem never becomes a caller crash.
let fileStream: WriteStream | null = null;
let fileSinkFailed = false;

/**
 * Tee every subsequent log line to `filePath` (append), in addition to the
 * console. Idempotent — the first call wins, later calls are no-ops, so a
 * process has exactly one file sink. Relative paths resolve against the current
 * working directory (the repo root for `npm run …` entry points). Failures to
 * open or write are swallowed (marked `fileSinkFailed`): logging is
 * best-effort and must never take down its caller.
 */
export function addFileSink(filePath: string): void {
	if (fileStream || fileSinkFailed) {
		return;
	}
	try {
		const abs = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
		mkdirSync(dirname(abs), { recursive: true });
		const stream = createWriteStream(abs, { flags: 'a' });
		stream.on('error', () => {
			fileSinkFailed = true;
		});
		fileStream = stream;
	} catch {
		fileSinkFailed = true;
	}
}

/** One buffered line: the `json` format's object, split into its four parts. */
export interface LogRingEntry {
	time: string;
	level: LogLevel;
	msg: string;
	context: LogContext;
}

/**
 * What {@link queryLogRingBuffer} matches on. Every given field must match;
 * `level` is a minimum, `since` is inclusive and `until` exclusive. `taskId`,
 * `prNumber` and `dispatchId` match the line's own context keys of those names
 * and `projectId` its `projectId` — the keys SWARM's log call sites use — compared
 * as strings, since a call site may log a number where another logs a string.
 */
export interface LogRingFilter {
	projectId?: string;
	taskId?: string;
	prNumber?: number | string;
	dispatchId?: string;
	level?: LogLevel;
	since?: Date;
	until?: Date;
	/** Newest-first cap on the returned entries; defaults to every match. */
	limit?: number;
}

export interface LogRingQueryResult {
	/** Matching entries, newest first. */
	entries: LogRingEntry[];
	/** The buffer's capacity in entries — `0` when this process never enabled it. */
	capacity: number;
	/** How many entries it holds right now. */
	size: number;
	/** The time of the oldest entry it still holds, or `null` when empty. */
	oldestTime: string | null;
}

// A line too large to keep whole (an error carrying a huge payload) is kept as
// its level, time, message and correlation keys, so it still turns up under the
// filters without letting one line pin megabytes for the life of the process.
const MAX_BUFFERED_LINE_CHARS = 16_384;
const RING_FILTER_KEYS = ['projectId', 'taskId', 'prNumber', 'dispatchId'] as const;
type RingFilterKey = (typeof RING_FILTER_KEYS)[number];

// Stored as the serialized line rather than the caller's context object: the
// snapshot cannot be mutated afterwards, holds no reference to anything the
// caller keeps alive, and is parsed only when a query actually returns it. The
// filter keys are pulled out beside it so a query never parses a non-match.
interface BufferedLine {
	timeMs: number;
	time: string;
	level: LogLevel;
	keys: Partial<Record<RingFilterKey, string>>;
	line: string;
}

let ring: (BufferedLine | undefined)[] = [];
let ringNext = 0; // the slot the next line is written to
let ringSize = 0;

/**
 * Keep the most recent `capacity` emitted lines in memory, for
 * {@link queryLogRingBuffer}. Off unless a process calls this (only the router
 * does). Each call starts a fresh, empty buffer of the given capacity; a
 * non-positive capacity turns it off. It records exactly what passes
 * `SWARM_LOG_LEVEL`, like the file sink.
 */
export function enableLogRingBuffer(capacity: number): void {
	const size = Number.isFinite(capacity) ? Math.max(0, Math.floor(capacity)) : 0;
	ring = new Array<BufferedLine | undefined>(size);
	ringNext = 0;
	ringSize = 0;
}

function asFilterValue(value: unknown): string | undefined {
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'bigint') return String(value);
	return undefined;
}

function recordInRing(level: LogLevel, message: string, context: LogContext, time: string): void {
	if (ring.length === 0) return;
	try {
		const keys: BufferedLine['keys'] = {};
		for (const key of RING_FILTER_KEYS) {
			const value = asFilterValue(context[key]);
			if (value !== undefined) keys[key] = value;
		}
		let line = formatJson(level, message, context, time);
		if (line.length > MAX_BUFFERED_LINE_CHARS) {
			line = safeStringify({
				level,
				time,
				msg: message.slice(0, MAX_BUFFERED_LINE_CHARS / 2),
				...keys,
				_truncated: true,
			});
		}
		ring[ringNext] = { timeMs: Date.parse(time), time, level, keys, line };
		ringNext = (ringNext + 1) % ring.length;
		ringSize = Math.min(ringSize + 1, ring.length);
	} catch {
		// Best-effort, like every other sink: a line that cannot be buffered is
		// simply not buffered.
	}
}

function toRingEntry(buffered: BufferedLine): LogRingEntry {
	try {
		const {
			level: _level,
			time: _time,
			msg,
			...context
		} = JSON.parse(buffered.line) as {
			msg?: unknown;
		} & LogContext;
		return {
			time: buffered.time,
			level: buffered.level,
			msg: typeof msg === 'string' ? msg : String(msg),
			context,
		};
	} catch {
		return { time: buffered.time, level: buffered.level, msg: '', context: { ...buffered.keys } };
	}
}

function matchesRingFilter(buffered: BufferedLine, filter: LogRingFilter): boolean {
	for (const key of RING_FILTER_KEYS) {
		const wanted = filter[key];
		if (wanted !== undefined && buffered.keys[key] !== String(wanted)) return false;
	}
	if (filter.level && LEVEL_WEIGHT[buffered.level] < LEVEL_WEIGHT[filter.level]) return false;
	if (filter.since && buffered.timeMs < filter.since.getTime()) return false;
	if (filter.until && buffered.timeMs >= filter.until.getTime()) return false;
	return true;
}

/**
 * The buffered lines matching `filter`, newest first, plus the buffer's own
 * extent so a reader can tell "nothing happened" from "that is older than the
 * buffer". Returns no entries (and `capacity: 0`) in a process that never
 * enabled it. Never throws.
 */
export function queryLogRingBuffer(filter: LogRingFilter = {}): LogRingQueryResult {
	const capacity = ring.length;
	const entries: LogRingEntry[] = [];
	const slot = (offset: number) => ring[(ringNext - offset + capacity) % capacity];
	const oldestTime = ringSize > 0 ? (slot(ringSize)?.time ?? null) : null;
	try {
		const limit = filter.limit ?? Number.POSITIVE_INFINITY;
		for (let offset = 1; offset <= ringSize && entries.length < limit; offset += 1) {
			const buffered = slot(offset);
			if (buffered && matchesRingFilter(buffered, filter)) {
				entries.push(toRingEntry(buffered));
			}
		}
	} catch {
		// Fall through with whatever was collected.
	}
	return { entries, capacity, size: ringSize, oldestTime };
}

function resolveMinLevel(): number {
	const raw = process.env.SWARM_LOG_LEVEL?.toLowerCase();
	if (raw && raw in LEVEL_WEIGHT) {
		return LEVEL_WEIGHT[raw as LogLevel];
	}
	return LEVEL_WEIGHT.info;
}

function resolveFormat(): 'json' | 'pretty' {
	const raw = process.env.SWARM_LOG_FORMAT?.toLowerCase();
	if (raw === 'json' || raw === 'pretty') {
		return raw;
	}
	// Unset: pretty on an interactive terminal, json when piped/containerized so
	// production stdout is aggregator-friendly without any explicit config.
	return process.stdout.isTTY ? 'pretty' : 'json';
}

// A logger must never crash its caller, so JSON.stringify is guarded on two
// fronts: a replacer coerces BigInt (which stringify throws on outright) to a
// string, and a try/catch fallback emits a still-valid line carrying the
// message plus a _logError marker if anything else is unserializable (e.g. a
// circular reference). Call sites pass plain ids/strings today, so this is
// belt-and-suspenders — but the logger is the sanctioned structured path now.
function safeStringify(value: unknown): string {
	return JSON.stringify(value, (_key, val) => (typeof val === 'bigint' ? val.toString() : val));
}

// Colors are opt-out, not opt-in: a real terminal gets them unless NO_COLOR is
// set (https://no-color.org); anything else (piped, redirected, CI) stays plain
// even if SWARM_LOG_FORMAT=pretty was forced, since ANSI codes would just be
// noise in a file or log aggregator.
function useColor(): boolean {
	return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const LEVEL_COLOR: Record<LogLevel, string> = {
	debug: '\x1b[90m', // gray
	info: '\x1b[36m', // cyan
	warn: '\x1b[33m', // yellow
	error: '\x1b[31m', // red
};

function paint(text: string, code: string): string {
	return useColor() ? `${code}${text}${RESET}` : text;
}

// HH:MM:SS in the local clock — a human tailing dev output cares what time it
// is on their wall, not the UTC-offset ISO timestamp the json format needs for
// aggregator sorting.
function formatClock(time: string): string {
	return new Date(time).toLocaleTimeString('en-GB');
}

function formatContextValue(value: unknown): string {
	if (typeof value === 'string') {
		return /\s/.test(value) ? JSON.stringify(value) : value;
	}
	if (value === null || typeof value !== 'object') {
		return String(value);
	}
	return safeStringify(value);
}

// `key=value key2=value2`, skipping undefined (most context fields — e.g. an
// optional movedTo — are conditionally undefined, and printing "movedTo=undefined"
// on every other line is noise, not information).
function formatContextTail(context: LogContext): string {
	const entries = Object.entries(context).filter(([, value]) => value !== undefined);
	if (entries.length === 0) {
		return '';
	}
	const rendered = entries.map(([key, value]) => `${key}=${formatContextValue(value)}`).join(' ');
	return ` ${paint(rendered, DIM)}`;
}

// One JSON object per line — used by the `json` console format and always by
// the file sink. Extracted so both share identical, guarded serialization.
function formatJson(level: LogLevel, message: string, context: LogContext, time: string): string {
	try {
		return safeStringify({ level, time, msg: message, ...context });
	} catch (err) {
		return safeStringify({
			level,
			time,
			msg: message,
			_logError: err instanceof Error ? err.message : String(err),
		});
	}
}

function format(level: LogLevel, message: string, context: LogContext, time: string): string {
	if (resolveFormat() === 'json') {
		return formatJson(level, message, context, time);
	}
	try {
		const { component, ...rest } = context;
		const prefix = component ? ` ${paint(`[${component}]`, DIM)}` : '';
		const clock = paint(formatClock(time), DIM);
		const levelTag = paint(level.toUpperCase().padEnd(5), LEVEL_COLOR[level]);
		return `${clock} ${levelTag}${prefix} ${message}${formatContextTail(rest)}`;
	} catch (err) {
		return `[${level}] ${message} {"_logError":${JSON.stringify(err instanceof Error ? err.message : String(err))}}`;
	}
}

function emit(level: LogLevel, message: string, context?: LogContext): void {
	if (LEVEL_WEIGHT[level] < resolveMinLevel()) {
		return;
	}
	const merged = { ...baseContext, ...context };
	// ISO 8601 timestamp sorts lexicographically, which log aggregators rely on.
	const time = new Date().toISOString();
	console[level === 'debug' ? 'log' : level](format(level, message, merged, time));
	if (fileStream && !fileSinkFailed) {
		// Always JSON to the file, independent of the console format; guard the
		// write so a sink problem can't propagate into the caller.
		try {
			fileStream.write(`${formatJson(level, message, merged, time)}\n`);
		} catch {
			fileSinkFailed = true;
		}
	}
	recordInRing(level, message, merged, time);
}

export const logger = {
	debug: (message: string, context?: LogContext) => emit('debug', message, context),
	info: (message: string, context?: LogContext) => emit('info', message, context),
	warn: (message: string, context?: LogContext) => emit('warn', message, context),
	error: (message: string, context?: LogContext) => emit('error', message, context),
};
