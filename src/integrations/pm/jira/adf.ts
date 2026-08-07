/**
 * Atlassian Document Format ↔ plain text — the wire format of the Jira client's
 * rich-text fields, so it belongs beside the client rather than with the reads and
 * writes that happen to use it.
 *
 * REST **v3** carries `description` and comment bodies as ADF documents, not
 * strings, while SWARM's own shapes are plain text: `WorkItem.description`
 * (`src/pm/types.ts`) is a `string`, and the bodies phases post are agent-authored
 * markdown-ish text. That needs exactly two conversions, in opposite directions.
 *
 * **{@link textToAdf} is deliberately not a markdown renderer.** Cascade converts
 * with `marklassian` (`cascade/src/pm/jira/adf.ts`); SWARM emits one paragraph per
 * line and nothing else. A half-correct renderer mangles the fenced code, tables,
 * and HTML comment markers SWARM's comment bodies actually contain, and a mangled
 * body is worse in a human's Jira than an unstyled one. Don't "improve" this into
 * a markdown port — add the dependency deliberately, with the markers below tested,
 * or leave it plain.
 *
 * **{@link adfToPlainText} keeps hidden SWARM markers verbatim.** The
 * `<!-- swarm-… -->` markers are how SWARM recognises its own output
 * (`isSwarmGeneratedBody`, `src/scm/swarm-origin.ts`) and how a later phase's
 * `findComment` finds a prior delivery, so a marker that does not survive the round
 * trip would silently break comment idempotency and loop prevention. It is the
 * load-bearing property of this module.
 */

/** A node of an ADF document, as loosely as a walker needs to read one. */
export interface AdfNode {
	type?: string;
	content?: unknown[];
	text?: string;
	attrs?: Record<string, unknown>;
}

/** A whole ADF document — what {@link textToAdf} produces for a Jira write. */
export interface AdfDocument {
	version: 1;
	type: 'doc';
	content: AdfNode[];
}

/**
 * Block nodes whose children are inline content: their text is one paragraph, so
 * marked-up runs (bold, links, inline code) concatenate instead of each landing on
 * its own line. A `codeBlock`'s text already carries its own newlines.
 */
const INLINE_BLOCK_TYPES = new Set(['paragraph', 'heading', 'codeBlock']);

function asNode(value: unknown): AdfNode {
	return value && typeof value === 'object' ? (value as AdfNode) : {};
}

/** Concatenated text of a node's inline subtree; a hard break is a newline. */
function inlineText(node: AdfNode): string {
	if (node.type === 'hardBreak') return '\n';
	if (node.type === 'text') return node.text ?? '';
	if (!Array.isArray(node.content)) return node.text ?? '';
	return node.content.map((child) => inlineText(asNode(child))).join('');
}

function childLines(node: AdfNode): string[] {
	return (node.content ?? []).flatMap((child) => nodeLines(asNode(child)));
}

/**
 * The plain-text lines a node contributes. An unrecognized node type — a panel, a
 * table, an app-supplied extension — is treated as a container and recursed into
 * rather than dropped, so its text survives even though its formatting doesn't.
 */
function nodeLines(node: AdfNode): string[] {
	if (node.type === 'text' || node.type === 'hardBreak') return inlineText(node).split('\n');
	if (node.type && INLINE_BLOCK_TYPES.has(node.type)) {
		return [...inlineText(node).split('\n'), ''];
	}
	// A list item's own paragraphs are its lines: keeping the blank line each
	// paragraph ends with would space a bullet list out by an empty line per item.
	if (node.type === 'listItem') return childLines(node).filter((line) => line !== '');
	if (Array.isArray(node.content)) return [...childLines(node), ''];
	return inlineText(node).split('\n');
}

/**
 * Read an ADF document (or any subtree) as plain text.
 *
 * Returns `''` for absent content — Jira omits `description` entirely on an issue
 * that has none — and passes a plain `string` straight through, since a v2-shaped
 * payload or a webhook body can carry one where v3 carries a document.
 */
export function adfToPlainText(document: unknown): string {
	if (typeof document === 'string') return document;
	if (!document || typeof document !== 'object') return '';
	return nodeLines(document as AdfNode)
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/** Wrap plain text as an ADF document — one paragraph per line, blank lines included. */
export function textToAdf(text: string): AdfDocument {
	return {
		version: 1,
		type: 'doc',
		content: text.split('\n').map((line) => ({
			type: 'paragraph',
			content: line ? [{ type: 'text', text: line }] : [],
		})),
	};
}
