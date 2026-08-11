# Design system — dashboard

Visual and component conventions for SWARM's dashboard (`dashboard/`, ai/RULES.md §5 issues #75–87). Read this before building any dashboard screen, the same way `ai/CODING_STANDARDS.md` governs backend code.

## Origin

This system was extracted from a Google AI Studio–generated UI-only prototype (local sibling checkout `../swarm-ui`, not part of this repo) built specifically to explore the dashboard's look and navigation shape with no real logic behind it (see `GOOGLE_AI_PROMPT` for the prompt that produced it). That prototype is disposable scaffolding, not a dependency — do not symlink or import from it. Everything worth keeping from it is captured below; §7 lists what was deliberately *not* carried over.

Stack it assumes: React + TypeScript + Vite + **Tailwind CSS v4** (CSS-first config, `@import "tailwindcss"` — no `tailwind.config.js`) + `lucide-react` for icons. Issue #81 (frontend scaffold) needs to add Tailwind and `lucide-react` to the stack described there — the original issue text predates this design system and doesn't mention either.

## 1. Color tokens

**Dark by default, with Light and System-default alternatives** (issue #250) — this is still a local admin tool for one developer, not a public product, but it now respects the developer's own theme preference. Every color below is authored as a **dark-mode value at `:root`**; picking Light (directly, or via System default resolving to light) sets `data-theme="light"` on `<html>` (`dashboard/src/components/theme/theme-provider.tsx`), and `dashboard/src/index.css` overrides the *same* Tailwind v4 theme variables under a `[data-theme="light"]` selector. Because Tailwind v4 compiles every utility against its CSS variable (`.bg-zinc-900 { background-color: var(--color-zinc-900) }`, not a literal color), overriding the variable repaints every `zinc-*`/status-color utility already in use — component code never branches on theme.

| Role | Token | Dark value | Usage |
|---|---|---|---|
| Canvas | `canvas` (custom, semantic) | `#0A0A0B` | Page/app background — `bg-canvas` |
| Panel | `panel` (custom, semantic) | `#0F0F11` | Sidebar, cards, modals — usually blended with alpha (`bg-panel/20`–`/40`) over the canvas rather than opaque |
| Border (strong) | `zinc-800` | `#27272a` | Default dividers, input borders, card borders |
| Border (soft) | `zinc-850` (custom, see below) | `#1f1f23` | Header/section dividers, secondary borders — one step darker than `zinc-800` |
| Text — primary | `zinc-100` | `#f4f4f5` | Headings, primary values |
| Text — secondary | `zinc-300`/`zinc-200` | | Body emphasis, table cells |
| Text — tertiary | `zinc-400` | | Field labels, helper text |
| Text — muted | `zinc-500` | | Meta text, table headers, placeholders |
| Text — faint | `zinc-600` | | Input placeholder text |
| Accent (primary action) | `violet-600` / `violet-500` | | Primary buttons, active tab underline, focus rings — **theme-invariant**, see below |
| Success | `emerald-500`/`emerald-400` | | Connected/verified status |
| Warning | `amber-500`/`amber-200`/`amber-900` | | Loop-prevention and similar caution banners |
| Danger | `red-400`/`red-500`/`red-900` | | Validation errors, destructive-action affordances |

**Fix required, don't copy verbatim**: `zinc-850` and `violet-650` are not real Tailwind shades (the prototype uses `zinc-850` ~10 times and the primary-button glow recipe below uses `violet-650`, but it ships zero-config Tailwind v4, so those classes are silently dead). Define both for real in `dashboard/src/index.css` via Tailwind v4's `@theme`, alongside the semantic `canvas`/`panel` tokens (promoted from the literal `bg-[#0A0A0B]`/`bg-[#0F0F11]` the prototype hardcoded, so they can be overridden per-theme instead of staying frozen dark forever):

```css
@import "tailwindcss";

@theme {
  --color-zinc-850: #1f1f23;
  --color-violet-650: #7531e3;
  --color-canvas: #0a0a0b;
  --color-panel: #0f0f11;
}
```

**The light-theme override rule.** `dashboard/src/index.css`'s `[data-theme="light"]` block re-derives every neutral/status color it needs from the *other end* of that color's own Tailwind scale — it does not invent new hex values:

- **`canvas`/`panel`/`zinc-850`** get hand-picked light equivalents (near-white canvas, a slightly-off-white panel).
- **The full `zinc` neutral scale inverts shade-for-shade**: `100↔950`, `200↔900`, `300↔800`, `400↔700`, `500↔600` (e.g. light-theme `--color-zinc-900` takes dark-theme `zinc-200`'s value). A role authored for dark (light text on a dark panel, a dark input on a darker canvas) reads correctly once background and foreground swap ends of the scale — no per-component light/dark class list to maintain.
- **Status hues** (`red`/`orange`/`amber`/`emerald`/`sky`/`blue`/`violet`) swap only the banner/badge-adjacent ends — `100↔950`, `200↔900`, `300↔800`, `400↔700` — the shades `ai/DESIGN_SYSTEM.md`'s own banner/badge recipes below actually use for tinted backgrounds, borders, and text.
- **Shades 500/600 for every hue are deliberately left alone.** They're the solid-fill brand/accent colors — primary buttons, focus rings, the active-tab underline, a status badge's dot/bg tint — which read the same in both themes rather than inverting with the neutrals. This is why "Accent (primary action)" above is marked theme-invariant.

New component work should default to the existing named-shade recipes below; reach for `bg-canvas`/`bg-panel` instead of a literal hex, and treat 500/600 accent shades as fixed brand color rather than something to special-case per theme.

## 2. Typography

- Sans (default) for all human-authored UI text — labels, headings, descriptions, button text.
- **`font-mono` for every machine/technical value**: project/branch IDs, repo paths, filesystem paths, GitHub node IDs, tokens/secrets. This distinction is load-bearing — it's how a user visually tells "a thing I typed" from "a thing the system generated" at a glance. Apply it consistently to any new field that holds an identifier.
- Scale:
  - Page title: `text-2xl font-semibold tracking-tight text-zinc-100`
  - Section heading (inside a card/tab): `text-sm font-semibold text-zinc-200`, with `border-b border-zinc-800 pb-2`
  - Field label: `text-xs font-medium text-zinc-400`
  - Helper/description text: `text-xs text-zinc-400` (or `text-zinc-500` when more muted)
  - Table header cell: `text-xs font-semibold uppercase tracking-wider text-zinc-400`
  - Body/table cell: `text-sm`

## 3. Spacing, radius, elevation

- Radius: `rounded` for inputs/small chips, `rounded-md` for buttons and table wrappers, `rounded-lg` for cards/modals/empty states. Nothing fully rounded except status dots.
- Section rhythm: `space-y-6` between major sections of a screen, `space-y-4` inside a form, `gap-4` in grids.
- Standard form grid: `grid grid-cols-1 md:grid-cols-2 gap-4` (2 columns on desktop); use `md:grid-cols-3` for groups of short fields (e.g. status-option IDs).
- Elevation stays flat — `shadow-sm` on cards, `shadow-2xl` on modals. The one deliberate exception: primary buttons get a colored glow, `shadow-lg shadow-violet-650/10` — reserve this for the single primary action on a given screen, not every button.

## 4. Component patterns

Each entry is the Tailwind "recipe" to reuse — treat these as the contract, not a suggestion, so screens stay visually consistent without a component library existing yet.

**Button — primary**
`inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-violet-600 rounded-md hover:bg-violet-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-violet-500 transition-colors shadow-lg shadow-violet-650/10`

**Button — secondary**
`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-300 bg-zinc-900 border border-zinc-800 rounded-md hover:bg-zinc-800 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 transition-colors` — `hover:text-zinc-100` (not `hover:text-white`), so hover text stays theme-aware rather than pinned white in Light.

**Button — icon/ghost** (e.g. table row delete)
`text-zinc-500 hover:text-red-400 p-1.5 rounded hover:bg-zinc-800/60 transition-colors`

**Input**
`block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500` — add `font-mono` for identifier/technical fields.

**Select** — same as Input, plus a disabled state for dependent dropdowns (e.g. "Model" disabled until "CLI" is chosen):
`disabled:opacity-50 disabled:bg-zinc-950 disabled:border-zinc-800 disabled:text-zinc-500`

**Label** — `block text-xs font-medium text-zinc-400`, required marker as `<span class="text-red-500">*</span>`.

**Toggle switch** — there is exactly one: `ToggleSwitch` (`dashboard/src/components/ui/toggle-switch.tsx`). Render it for every boolean; never hand-roll a second switch with its own size or colour. Track `h-5 w-9 rounded-full`, `bg-violet-600` on / `bg-zinc-700` off, a `h-4 w-4` white knob, `disabled:opacity-50 disabled:cursor-not-allowed`. It carries `role="switch"` + `aria-checked` and takes `label` as its accessible name — name what it controls, not its current state. It always calls `stopPropagation` so it can sit in a row that navigates on click. A state the viewer may see but not change (someone else's worker on `/workers`) renders it `disabled` with a `title` saying who can change it — a disabled switch states the fact; suppressing it entirely would hide it. When the value is genuinely unknown (its query is loading or failed), show a muted em dash with an explaining `title` instead — never an off switch.

**Card/panel** — `border border-zinc-800 rounded-lg bg-panel/40 p-6 shadow-sm` (drop the alpha fraction to `/20`–`/30` for a nested sub-panel inside another panel, so depth reads without a heavier border).

**Table** — bordered wrapper `border border-zinc-800 rounded-md overflow-hidden bg-panel/20 shadow-sm`; header row `bg-zinc-800/30 border-b border-zinc-800 text-xs uppercase tracking-wider text-zinc-400`; body rows `divide-y divide-zinc-800/60`, `hover:bg-zinc-800/40 transition-colors`. Whole-row-clickable-to-navigate is fine (`cursor-pointer` on `<tr>`) as long as any trailing per-row action button calls `stopPropagation`.

**Responsive list (table → cards on mobile)** — a wide multi-column table (roughly 5+ columns) does not fit a ~375–430px phone; horizontally scrolling it is not a mobile-native list. Instead render both presentations from the same data: the `<table>` above inside a `hidden md:block` wrapper, and a `md:hidden` stacked card list (`space-y-3`), one card per row. Each card is a nested sub-panel (`border border-zinc-800 rounded-lg bg-panel/20 p-4 shadow-sm`, generous spacing between cards for tap targets) with a deliberate hierarchy, **not** a uniform field dump: a **primary line** (the row's identifying title as the dominant text, the status badge on the same line), a lighter **secondary line** of supporting metadata (`text-xs text-zinc-400`), and a subordinate **footer** of reference details (`text-xs text-zinc-500`). No field is dropped — de-emphasized is fine, silently truncated is not; let long values wrap (`break-words`/`break-all`, `min-w-0`) so nothing forces horizontal scroll. A whole-card tap navigates like the desktop row (`role="button"`, `tabIndex={0}`, Enter/Space handling); in-card links/buttons call `stopPropagation` (or sit in a separated action row) so they don't trigger card navigation. The run lists (`RunsTable`, `QueuedRunsSection`) use this pattern; the shared desktop column widths live in `dashboard/src/lib/run-table-layout.ts`.

**Describing a run's work** — never label a run by its id: a UUID tells an operator nothing. Render `WorkItemCell` (`dashboard/src/components/runs/work-item-cell.tsx`) — the resolved Issue/PR title as the primary line over its `Issue: #n` / `PR #n` provider reference — so every screen describes the same run identically (issue #473). Pass `titleHref` where the surrounding row isn't already clickable (the Workers table's **Active job** column) and the title becomes the link to the run; omit it where the row navigates on click, so the cell doesn't swallow it. Pass `phaseLabel` only where the surface has no Phase column of its own — it adds a leading line above the title rather than crowding it — and never alongside one, which would say the same thing twice in the same row.

**Fixed-width columns** — a table whose cells hold prose needs `table-fixed` plus a `<colgroup>` of percentage widths, so `truncate` actually truncates and one long title can't push the row sideways. Give the prose column the bulk of the width and size the rest to their own content (`RunsTable`, `WorkersTable`). A table like that is the page's content, not a card in it: don't cap the route in a `max-w-*` wrapper and leave a gutter — the freed width belongs to the prose column.

**Tabs** (underline style) — active: `border-b-2 border-violet-500 text-zinc-100 bg-zinc-800/20`; inactive: `border-b-2 border-transparent text-zinc-500 hover:text-zinc-300 hover:border-zinc-800`. Shared button base: `flex items-center gap-2 px-5 py-3 text-sm font-semibold transition-all`. Active-tab text is `text-zinc-100` (not `text-white`) so it stays legible against the light-theme `bg-zinc-800/20` tint, not just the dark one.

**Modal/dialog** — full-screen centered overlay, backdrop `fixed inset-0 bg-black/80`; panel `bg-panel border border-zinc-800 rounded-lg shadow-2xl`; footer actions `flex flex-row-reverse gap-2` so the primary action reads first visually while staying last in DOM/tab order... actually keep the primary action first in tab order too — see §7, this is one of the prototype's few accessibility misses worth fixing rather than copying.

**Banner — neutral/info** — `p-3 bg-zinc-900/50 border border-zinc-800 text-sm text-zinc-300 rounded`.

**Banner — warning** — `p-4 bg-amber-950/20 border border-amber-900/30 rounded`, icon `text-amber-500`, heading `text-xs font-semibold text-amber-200`, body `text-xs text-amber-200/70`. Dismissible via a small uppercase text button (`text-zinc-500 hover:text-zinc-300 text-xs uppercase tracking-wider`).

**Banner — error** — `p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded`.

**Status dot** (e.g. daemon connection) — `h-2 w-2 rounded-full bg-emerald-500 ring-4 ring-emerald-500/10`.

**Meta pill/badge** (e.g. version tag) — there is exactly one: `Badge` (`dashboard/src/components/ui/badge.tsx`), geometry `px-2 py-0.5 text-[10px] uppercase font-mono font-bold tracking-wider rounded border`, neutral hue `bg-zinc-850 text-zinc-400 border-zinc-800`. Render it for every short stamped label; never hand-roll a second pill with its own size or weight. Only the **hue** varies, via its `tone`: `positive`/`caution`/`negative` carry state (the worker detail view's enrollment approval status and its routable/not-routable verdict) — `caution` (`bg-amber-950/20 text-amber-200 border-amber-900/30`) also makes the `planning` badge read ahead of the others wherever it appears (the `/workers` Capabilities cell, the worker detail view's declared and allowed pipeline phases), the same amber whether or not that instance of `planning` is otherwise flagged unavailable. Same geometry, same spacing, different weight of voice; never resize a badge to emphasize it.

**Pipeline-phase order** — wherever a screen lists pipeline phases (the worker detail view's declared and allowed phases, the Runs Phase filter), the sequence is the pipeline's own — `planning → implementation → review → respond to review → respond to ci → resolve conflicts` — via `sortPipelinePhases` (`dashboard/src/lib/pipeline-phases.ts`) for a list a daemon or read model handed over, or a map over `ALL_TRIGGER_PHASES` (`src/triggers/types.ts`) when the list *is* the whole vocabulary; never the order a value happened to arrive in, and never a hand-written sequence, so a seventh phase orders itself everywhere at once (issue #548).

**Checkbox** — `h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-violet-600 focus:ring-1 focus:ring-violet-500 disabled:opacity-50 disabled:cursor-not-allowed`, inside a `<label className="inline-flex items-center gap-2 text-sm text-zinc-300">` so the text is the accessible name (add `font-mono` to that text for an identifier, e.g. a CLI name). Use it for a *set* of independent booleans where a row of switches would read as unrelated toggles (the worker detail view's allowed agent CLIs); a single boolean stays a `ToggleSwitch`. When one box may not be unchecked because the server would reject the result (the last allowed CLI), render it `disabled` with a `title` saying why — same rule as a switch the viewer may see but not change.

**Masked-secret field + verify** (credentials screen) — collapsed state shows a read-only preview box (`px-3 py-2 border border-zinc-800/85 bg-zinc-900/40 rounded text-sm font-mono text-zinc-400`) rendering a fixed opaque marker, `••••`, identical for every configured credential regardless of its length — it discloses only that the credential is configured, never a last-4 (or any other) fragment of the secret — with an "Edit" secondary button that swaps it for a real `Input`. A paired "Verify" button toggles between the default secondary-button look and a success look (`bg-emerald-500/10 border-emerald-500/20 text-emerald-400`) plus an inline `✓ Verified as @<login>` label in `text-emerald-400`.

**Icons** — `lucide-react`, `w-4 h-4` standard size (`w-3.5`/`w-3` for compact contexts like inline badges, `w-5` for banner icons); empty-state icons are larger and fainter: `w-12 h-12 stroke-1 text-zinc-700`.

## 5. Layout shell

- Left sidebar (`w-64` on desktop, full-width stacked on mobile), `bg-panel`, bordered `border-r border-zinc-800`. Top: wordmark + version pill. Middle: nav grouped under a small uppercase section label (`text-[10px] font-semibold uppercase tracking-widest text-zinc-500`). Bottom: a **compact account row** — connection status dot, the signed-in user's name linking to `/profile`, and Sign out — on one line, `border-t border-zinc-850 px-4 py-3`.
- **The account row is pinned, the nav scrolls (issue #665).** On desktop the sidebar is its own bounded column (`md:sticky md:top-0 md:h-screen`) whose wordmark+nav wrapper is the only scrolling part (`md:min-h-0 md:flex-1 md:overflow-y-auto`), so the account row stays reachable however long the project list grows. Below `md` the sidebar stacks full-width above the content and flows with the page — a pinned 100vh column would fill a phone screen. Add new nav to the scrolling wrapper, not beside the account row; anything put outside the wrapper permanently costs the nav that much height.
- **The connection state is a dot, not a sentence.** The footer is an account area, so the dot carries the state on its own (`title` for its accessible name); don't reintroduce a "Connected"/"Disconnected" label beside it.
- Main content: centered column, `max-w-5xl mx-auto`, `p-4 md:p-8`.
- Detail screens get a breadcrumb (`text-xs font-mono text-zinc-500`, current segment `text-zinc-300 font-semibold`) above the page title, then a horizontal tab bar, then the active tab's content in its own card.

## 6. Voice

Technical and precise, aimed at the engineer running SWARM — not marketing copy. E.g. "Point SWARM to your local working copies, configure git branching prefixes, and target stable base integration points." rather than "Manage your workspace settings here!" Helper text under a section heading should say *why* the setting exists, not just restate the field names.

## 7. Deliberate deviations from the prototype

The prototype is a disposable, logic-free stub (per `GOOGLE_AI_PROMPT`) and took some shortcuts that must NOT carry over into the real dashboard:

- **No `localStorage` persistence.** The prototype fakes state durability with `localStorage` because it has no backend. The real dashboard persists everything through the `projects`/`credentials` tRPC routers (#78, #79) — don't add a client-side persistence layer that could drift from server state.
- **No native `window.confirm()`.** The prototype uses it for delete confirmation. Build a real confirm dialog using the Modal pattern (§4) instead — `confirm()` can't be styled, isn't tested, and blocks the JS thread.
- **No fixed-timeout inline "saved" banners as the only save feedback.** The prototype's `setTimeout(() => setSavedMessage(''), 3000)` pattern is fine as a stopgap but a real save should surface tRPC mutation state (pending/error/success) properly — reuse the neutral banner's visual style for a real toast/status component instead of re-deriving the timeout dance on every form.
- **No demo-only UI.** The prototype's "Demo State Triggers" checkbox (a fake toggle for the loop-prevention warning) exists only to preview a state that should instead be driven by real data (the implementer/reviewer login comparison, once #80's `verifyGithubToken` result is available on both fields).
- **Primary-action tab order.** The prototype's modal footer uses `flex-row-reverse` purely for visual placement (primary button on the right), which also reverses tab order. Keep the visual placement but fix the DOM order (or `tabIndex`) so keyboard users reach the primary action first, not last.
