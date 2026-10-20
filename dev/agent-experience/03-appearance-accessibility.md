# Appearance and accessibility implementation design

Date: October 19, 2026. Source baseline: `e5d31084e5d2c4861723dca4d4c2931a64b0f732`.
Status: implementation-ready proposal; no product implementation or validation is claimed.
Scope: V1–V8 in the [current review](../agent-harness-and-experience-review-2026-10-19.md#typography-and-gui-findings).

This document defines the appearance contract future implementation agents must share.
It covers readable text, theme colors, sizing preferences, accessible controls,
sidebar geometry and narrow conversation layouts. It does not research or design
a new coding model, harness or Composer product. References to the existing
`Composer.tsx` concern shared typography and accessibility consumers only.

The user requested a comfortable desktop experience inspired by their ordinary
Codex workflow. The values below are proposed PacketBench values, **not measured
Codex fonts, spacing or colors**. Windows source evidence is available; native
Mac rendering and visual parity remain unverified. The earlier native hang is
owned by the root reliability work and is not attributed to typography.

## Evidence and constraints

- `src/index.css:49–56` defines UI 11/16px, metadata 10/14px, transcript 13/21px
  and chips 11.5/16px. `tailwind.config.ts:52–58` exposes these tokens.
- `src/components/views/ToolsView.tsx:182` adds 9px navigation labels;
  `src/components/views/tools/AgentSettingsCard.tsx:155` uses 10px helper text.
- The existing Inter 400/500/600/700 bundles are imported by `src/index.css:1–4`.
  Keep them. There is no evidence that changing the sans family is the first fix.
- `src/components/common/MarkdownRenderer.tsx:72–77` uses `oneDark` and an inline
  11px wrapper size; `src/index.css:191–193` separately defines 11.5px Agent code.
  The cascade must be measured; not every code element necessarily computes to 11px.
- `src/components/agents/AgentSidebar.tsx:362` fixes the sidebar at 252px;
  lines 309–355 contain small rows, truncated titles and approximately 14px actions.
- `src/components/agents/composer/ContextStrip.tsx:21–22,92` combines nonshrinking
  chips with `overflow-hidden`. `src/styles/conversation-tile.css:19–23` hides
  status labels below 340px. These are source findings, not native Mac observations.
- Theme is already owned by `appStore.theme` / `setTheme` and persisted through
  `src/App.tsx:176–194` and the backend UI slice. Tool verbosity is already owned
  by `agentSettingsStore.transcriptViewMode`. Preserve both ownership boundaries.
- `src/hooks/useXterm.ts:24–30` currently initializes terminal text at 13px with
  line height 1.15. `terminalSettingsStore` currently persists the shell choice,
  not a demonstrated text-size preference. Do not document a nonexistent terminal
  font control as already shipped. V3 owns the additive terminal preference,
  Appearance control and live xterm update defined below.

The local AGENTS/CLAUDE guidance currently favors compact 10–12px UI. The user's
readability request authorizes a future implementation to change that convention.
At integration, amend the ignored local instructions and copy the amendment to
the counterpart file, preserving their required parity. This documentation task
does not edit either file.

## Shared settings and rendering contract

### One preference store; existing theme owner

Create `src/stores/appearanceStore.ts` using Zustand and the existing storage
helpers. Derive its key with `storageKey("appearance")`; do not hardcode the brand
prefix. Persist only the following documented preferences:

```ts
type AppScalePercent = 100 | 110 | 125 | 150 | 175 | 200;
type InterfaceDensity = "comfortable" | "compact";

interface AppearancePreferencesV1 {
  schemaVersion: 1;
  uiScalePercent: AppScalePercent; // label in UI: App scale
  transcriptFontSizePx: number; // integer BASE size, 13..22, default 15
  density: InterfaceDensity; // default comfortable
  agentSidebarWidthPx: number; // integer CSS-pixel preference, 240..480
}
```

Defaults: `{schemaVersion:1, uiScalePercent:100, transcriptFontSizePx:15,
density:"comfortable", agentSidebarWidthPx:300}`. Sidebar width is a geometry
preference, not a font size; viewport constraints may reduce its rendered width
without rewriting the preference.

Actions: `setUiScalePercent`, `setTranscriptFontSizePx`, `setDensity`,
`setAgentSidebarWidthPx`, `resetTextAndLayout`, `hydrateFromStorage`.
Setters validate unknown inputs through one pure normalizer. Exact valid scale
steps are required; an unsupported scale falls back to 100 rather than inventing
a fractional step. Finite numeric reading/width values round to an integer and
clamp to their ranges. NaN, infinity, strings and missing fields use defaults.
Invalid enum values use defaults. An unknown newer schema is read conservatively
using defaults and is **not overwritten automatically at boot**; the first
explicit user edit may write the supported schema and must show that preferences
were reset if the stored version could not be read.

Keep `appStore.theme: "dark" | "light"` as the sole theme source and keep its
existing backend persistence. Do not copy it into `appearanceStore`, add a second
theme writer, or silently add a system-theme preference in V1–V8. A future System
mode would need its own migration and native theme-event contract. Do not put
display preferences in conversations, Flights, profiles, provider payloads or
backend execution policy.

Keep `transcriptViewMode` unchanged. Rename its visible setting **Tool detail**
with Summary / Normal / Verbose, so **Interface density** cannot be confused with
which tool content is shown. Existing keyboard cycling of tool detail remains.

### Final scaling rule: compute once, then consume

`uiScalePercent` is retained as the schema name; its product label is **App scale**.
Let `S = uiScalePercent / 100`. Reading size is a base preference, not an absolute
final size. This decision supersedes the earlier draft where reading size was
excluded from app scale: that draft could not enlarge all nonterminal text to 200%.

Create a pure `resolveAppearanceMetrics(preferences)` in
`src/lib/appearance.ts`. It emits **final absolute CSS-pixel values**, including
font sizes, line heights and target minima. Each final font is its domain's base
times S exactly once. Round to hundredths of a CSS pixel, not device pixels.
Never multiply by `devicePixelRatio`, OS display scale or another parent scale.

Examples that are regression fixtures:

- Default: UI 13px, transcript 15px, reading code 13px.
- Default + App scale 125%: UI 16.25px, transcript 18.75px, code 16.25px.
- Default + App scale 200%: UI 26px, transcript 30px, code 26px.
- Reading base 22px + App scale 200%: transcript **44px**, code **40px**.
- Compact + App scale 200%: UI 24px; reading remains 30px at the default base.

Do not use `transform: scale`, CSS `zoom`, root-font-size scaling, or automatic
Tauri/webview zoom to implement these preferences. Do not recompute S inside a
child. Changing the root rem size as well as final token values would scale some
text twice. Leave the root at its ordinary 16px base; all app font utilities must
resolve to the final appearance tokens. OS/user-agent magnification may operate
outside the app; the app must not detect it and apply a compensating multiplier.

The one root `useApplyAppearance` hook subscribes to the store and applies
`data-ui-density`, `data-ui-scale` and metric CSS properties to
`document.documentElement`. Mount it once in App; Monitor uses a read-only variant.
React portals inherit the same variables. No custom DOM event or new Tauri event
is needed. Do not mount one listener, document writer or store subscription per tile.

### Type and geometry tokens

The following are base values at 100%. Line heights are explicit, not inherited
from unrelated utility classes. `B` is `transcriptFontSizePx`; `C = max(13, B - 2)`.

| Role / CSS property                      | Comfortable base | Compact base | Weight          |
| ---------------------------------------- | ---------------- | ------------ | --------------- |
| `--text-ui` / `--leading-ui`             | 13 / 20px        | 12 / 18px    | 400; labels 500 |
| `--text-meta` / `--leading-meta`         | 12 / 16px        | 12 / 16px    | 400             |
| `--text-chip` / `--leading-chip`         | 12 / 18px        | 12 / 18px    | 400–500         |
| `--text-body` / `--leading-body`         | B / 1.6B px      | same         | 400             |
| `--text-composer` / `--leading-composer` | B / (22B/15) px  | same         | 400             |
| `--text-code` / `--leading-code`         | C / (20C/13) px  | same         | 400             |
| `--text-heading-1` / leading             | 18 / 26px        | same         | 600             |
| `--text-heading-2` / leading             | 16 / 24px        | same         | 600             |
| `--text-heading-3` / leading             | 15 / 22px        | same         | 600             |
| `--target-icon`                          | 32px square      | 32px square  | n/a             |
| `--target-primary`                       | 36px square      | 36px square  | n/a             |
| `--target-nav-row`                       | 36px minimum     | 32px minimum | n/a             |
| `--space-turn`                           | 24px             | 20px         | n/a             |
| `--space-control-gap`                    | 8px              | 6px          | n/a             |

Multiply these values by S in the resolver, including line heights and target
minima. Headings inside a transcript additionally have bases at least B+3, B+1
and B respectively, so a 22px reading base cannot make a heading smaller than its
paragraphs. Body labels and explanatory text use normal sentence case. Avoid
using uppercase tracking, italic styling or opacity as substitutes for hierarchy.

Keep the reading/composer maximum width 680 CSS pixels initially and make it
`max-width: min(100%, 680px)`. It is a layout constraint, not a value multiplied by
S. Use 8px side gutters below 480px tile width, 16px at 480–679px and 24px at
680px and above. Do not use viewport media queries to infer a tiled pane's width.
Use an outer tile query container and a child layout wrapper; container queries
cannot restyle the query container itself based on its own size.

The app scale enlarges all nonterminal text, including settings, dialogs,
attention, review, Flight controls, native-looking HTML chrome and portal menus.
It does not promise to magnify every fixed margin or entire window geometry.
Existing Tailwind `text-xs/sm/base/lg/...` compatibility utilities must point to
scaled equivalents of their 12/14/16/18/... bases until a consumer receives a
semantic role. Audit arbitrary `text-[Npx]`, SVG `fontSize` and inline code styles;
convert actual text to semantic tokens in owned consumers. Do not globally apply
`* { font-size: ... }`, override `.xterm` descendants, or replace every raw pixel
through a repository-wide substitution. Record unmigrated consumers; do not claim
all-text scaling until their rendered text is covered.

### Terminal boundary

PTY terminal canvas/glyph metrics remain terminal-owned. App scale changes the
surrounding pane/header and available geometry, but never changes
`xterm.options.fontSize`. A terminal font adjustment updates xterm's option and
fits the visible terminal through its existing fit/resize seam; it does not
recreate the PTY, send input or reinitialize an active session. Preserve hidden
workspace/zero-size guards in `useXterm`. Transient terminal modals follow this
same separate domain. Keep the separately selected terminal size when resetting
appearance preferences. Terminal reset must be a separately labelled action.

V3 owns an additive `terminalFontSizePx: number` field in
`src/stores/terminalSettingsStore.ts`, with `setTerminalFontSizePx` and
`resetTerminalFontSizePx`. Range is integer 10–32px, default the existing 13px.
The default can therefore be enlarged to 26px (200%) with room above it. Persist
the validated JSON number separately at `storageKey("terminal-font-size")`.
Leave `defaultShell`, its actions and the existing `terminal-default-shell`
storage key/migration untouched. Missing, malformed, nonnumeric or nonfinite
values use 13; finite values round/clamp. No new backend DTO is needed.

The Appearance card exposes a separate **Terminal text size** number input with
step buttons, the current size, **Reset terminal text size**, and the explanation
**Independent of App scale. Applies to Workspace terminals and terminal dialogs.**
It binds directly to this sole terminal preference owner, not an appearance-store
copy. Writing failure uses the same truthful save-warning pattern as Appearance.
Do not route global App-scale shortcuts to the PTY or introduce a competing
terminal keyboard font binding in V3. Existing terminal keystrokes retain their
current shell/TUI meaning; the settings control is fully keyboard accessible.

`useXterm` and `TransientPtyModal` initialize from this store and subscribe to
subsequent size changes. A size change sets `terminal.options.fontSize`, then
schedules one guarded visible fit through the existing fit/resize seam; an
invisible terminal defers fitting until its normal visibility recovery. Do not
add size to the terminal-construction effect's dependencies, dispose/recreate
the terminal, send synthetic resize keystrokes, or restart an active PTY.
Verify cursor/selection alignment, WebGL/canvas repaint, and terminal enlargement
through the actual control before declaring complete desktop text-resize coverage.

## Persistence, reset and shortcuts

Hydration must follow `main.tsx` → `bootPersistedStorage` → dynamic React/store
imports. Do not import appearance or app stores into `storage-boot.ts` and thereby
evaluate them before mirror restore. A missing appearance key installs the new
comfortable defaults in memory; the first explicit preference change persists
them. Do not infer compact mode from old `transcriptViewMode`, window size, OS,
theme, terminal font, or retired rail flags. No conversation or Flight migration
is needed. An existing Dark/Light preference remains unchanged.

Use the existing branded write-through storage mirror. Never restore a whole
profile to migrate one preference. Storage failure must keep live changes usable
and show **Changes apply now; saving preferences failed. Try again.** in the
Appearance card. `saveToStorage` currently swallows errors, so the new store's
write seam must return a typed success/failure result or use a scoped try/catch
that observes the actual write. Do not change unrelated callers' error behavior.
Clear the warning only after a confirmed successful write.

Monitor windows load appearance preferences after their existing boot path and
listen for `storage` changes to the single appearance key. Normalize and project
changes without persisting them back, starting a mirror writer, updating sessions
or remounting chat content. A malformed update retains the last valid projection.
Theme remains the existing app/backend responsibility; do not add a competing
theme source to solve Monitor styling. Read-only projection of that owner can be
wired in the same integration pass.

Expand the existing Theme card into **Appearance** under Settings → General →
Preferences. Keep theme buttons, then add labelled App scale select, Reading text
base-size input with step buttons, Interface density choice, and a live sample.
Show **Reading size: 15px × 125% = 18.75px** so the two controls are understandable.
The sample includes plain text, a filename, a warning, a menu action and a code
line. Do not add an arbitrary font picker or download fonts during Settings use.
Settings search keywords include `font`, `text`, `size`, `scale`, `zoom`,
`readability`, `density`, `appearance`, `terminal font`. The separately labelled
Terminal text size control above is live, not a placeholder or duplicate store.

**Reset text and layout** resets the four appearance preferences to defaults.
It retains theme, terminal size, tool detail, sidebar pins/project labels, drafts
and active work. State the reset's scope adjacent to its button. Theme reset is
not hidden inside this action. Resetting App scale via its shortcut changes only
`uiScalePercent` to 100, retaining the selected reading base and sidebar width.

Add three command-palette actions: **Increase App scale**, **Decrease App scale**,
**Reset App scale**. Their stable IDs are `appearance.appScale.increase`,
`appearance.appScale.decrease`, `appearance.appScale.reset`. Also add **Open
Appearance settings** with the existing settings-navigation API. Use action
functions from the same appearance module rather than duplicating arithmetic.

Shortcut policy:

- Windows/Linux: Ctrl+`+` or Ctrl+`=` increases; Ctrl+`-` decreases; Ctrl+`0` resets.
- Mac: Cmd+`+` or Cmd+`=` increases; Cmd+`-` decreases; Cmd+`0` resets. Ctrl remains
  available to terminals/readline and is not treated as Cmd on Mac.
- Match the produced `event.key` for `+`, `=`, `-`, `0`, including a keypad add or
  subtract key that yields the same character. Shift is permitted only for `+`.
  Do not bind Ctrl/Cmd+Shift+O (existing tool detail), Ctrl+Shift+V (dictation),
  Ctrl+K (existing palette), or OS accessibility magnification chords.
- Return on `defaultPrevented`, composing input (`isComposing`), Alt/AltGraph,
  another modifier combination, or `isTerminalTarget`. Ordinary text fields may
  invoke the exact modified scale chords without changing their value; unmodified
  plus/minus and number-input steppers retain their meaning. An inner control can
  consume the event first. Do not install an OS-global shortcut.
- On a recognized app-owned chord, call `preventDefault` once so the webview does
  not apply a second zoom. Increase/decrease selects the next explicit step;
  bounds remain stable and announce **Maximum/Minimum App scale**. Key repeat may
  advance steps but must not register multiple listeners or dispatch provider work.
- Extend `src/lib/platform.ts` for Mac detection through its existing safe platform
  seam; do not add independent user-agent sniffing in every component. If platform
  is unknown, retain menu/settings controls and match Ctrl only; never both modifiers.

Use one focusable status/live-region announcement after a change, e.g. **App
scale 125 percent. Reading text 18.75 pixels.** Do not move keyboard focus or scroll
the active transcript to the bottom. Preserve the visible message anchor when
virtualized row heights change; remeasure the existing virtualizer rather than
remounting the conversation or clearing its scroll/draft state.

## Palette decision and contrast proof

Keep the existing neutral surface colors. Use semantic text tokens with enough
contrast across the five ordinary surfaces in each theme. Proposed palette:

| Role              | Dark foreground | Dark minimum ratio | Light foreground | Light minimum ratio |
| ----------------- | --------------- | ------------------ | ---------------- | ------------------- |
| primary           | `#ededee`       | 12.218:1           | `#1e1e2e`        | 11.625:1            |
| secondary         | `#b9b9bd`       | 7.309:1            | `#454557`        | 6.639:1             |
| muted/help/meta   | `#a0a0aa`       | 5.516:1            | `#545467`        | 5.239:1             |
| success           | `#8ccfb0`       | 7.942:1            | `#126b4d`        | 4.600:1             |
| warning           | `#e0c477`       | 8.394:1            | `#6e5700`        | 4.919:1             |
| link/info/focus   | `#8db7ed`       | 6.895:1            | `#084e9b`        | 5.784:1             |
| error/destructive | `#f08b8b`       | 5.970:1            | `#a82727`        | 4.987:1             |
| reasoning/accent  | `#c1b4f4`       | 7.557:1            | `#644598`        | 5.229:1             |

Dark surfaces: `#0f0f10`, `#161617`, `#1c1c1e`, `#232326`, `#2a2a2e`.
Light surfaces: `#ffffff`, `#f8f8fc`, `#ededf5`, `#e4e4ee`, `#d8d8e6`.
Minimums above are computed over all five backgrounds, with no transparency,
using sRGB linearization and relative luminance `(0.2126R + 0.7152G + 0.0722B)`;
ratio is `(Llighter + .05)/(Ldarker + .05)`. Displayed ratios are rounded to three
places; tests compare the unrounded result. These are calculated design values,
not a screenshot or full-app accessibility certification.

Baseline failures for comparison: old dark faint `#5e5e66` on `#0f0f10` is
2.982:1; old light muted `#9d9db5` on white is 2.650:1; old light faint
`#b9b9c8` on white is 1.938:1. Alias the legacy `text-faint` token to the new muted
text color during migration. Add a distinctly named `--color-decorative` only for
noninformative decoration; do not move old readable content to that token.
Essential text does not use `opacity-*`, including placeholder and hover text.

Map these values through the existing theme/accent token names; consumers do not
hardcode colors. Keep decorative dividers quiet, but give form/control boundaries
that are necessary for recognition a separate `--color-control-border`:
dark `#8a8a91`, light `#66667a`. Give focus a separate opaque
`--color-focus-ring` with the link/info values above. Use a 2px outline plus 2px
offset; never an alpha-green border alone as the only focus indication.

The ratio table does **not** certify accent-alpha chip backgrounds, selected
states, disabled controls, syntax spans, diff additions/deletions, overlays or
filled buttons. Test actual composited foreground/background pairs. For a tinted
chip that fails, use primary text on that fill or an ordinary neutral background
with the colored icon. Do not merely declare all accent text exempt. Add
`--color-on-accent` as dark `#0f0f10` / light `#ffffff` for opaque accent-filled
buttons; the proposed solid success fill yields 10.644:1 / 6.490:1 respectively.
Use primary text on alpha accent fills and test their actual composites instead
of assuming white is universal.
Success, failure, permission and change states also retain words/icons; no
essential state may depend on color alone.

Normal informative text requires at least 4.5:1; necessary nontext control/focus
indicators require at least 3:1 against adjacent colors. These thresholds follow
[W3C text contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)
and [nontext contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html).

## Font and code implementation

Keep the bundled Inter sans stack: `Inter, system-ui, -apple-system, "Segoe UI",
sans-serif`. Regular text uses 400, labels 500, headings 600. Do not replace it
with unbundled SF Pro or require a user-installed Windows font. A future optional
native-system font choice is a separate comparison at the same sizes and colors.
Apple describes system and bundled fonts as distinct choices; Microsoft documents
language-aware Windows typography. Neither establishes a CSS-size equivalence to
this app or to Codex. See [Apple font categories](https://developer.apple.com/documentation/technologyoverviews/fonts)
and [Microsoft typography](https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/typography).

Use a single shared code stack: `ui-monospace, SFMono-Regular, Menlo, Monaco,
Consolas, "Liberation Mono", monospace`. This deliberately prefers the host's
monospace family rather than whichever optional JetBrains/Cascadia/Fira font
happens to be installed. It changes no bundled sans font and requires no new
font download. Verify punctuation and fallback metrics on each OS; do not assert
SF Mono/Cascadia availability. Keep terminal font choice separately owned; do not
silently overwrite a selected terminal family with the shared code stack.

Replace MarkdownRenderer's fixed `oneDark`, inline 11px and inline-code overrides
with one theme-aware semantic syntax style module and `--text-code` /
`--leading-code`. Use identical geometry in both themes. Proposed syntax roles:
plain/punctuation = primary/secondary; comments = muted; strings = success;
keywords = reasoning/accent; numbers/constants = warning; functions/links = info;
errors/deletions = error. Disable text shadows and decorative code italics. Ensure
`SyntaxHighlighter` inline styles inherit the same family, size and line height
as the `<code>` element; do not rely on a lower-specificity utility winning.

Markdown inline code, fenced code, tool output and diff text share these metrics.
Tables use the readable UI token and scroll within their own region if genuinely
two-dimensional. Code and side-by-side diffs may scroll horizontally as contained
exceptions; prose, errors, controls and their surrounding page must reflow. Give
code-copy controls an explicit name, visible focus and `group-focus-within`
visibility. Retain real text selection and copying; do not turn code into images.

## Shared controls and layout rules

### V5/V6 accessible actions

Introduce `src/components/ui/IconButton.tsx` with a required `label: string`,
`icon`, `onClick`, optional `disabled`, `pressed`, `expanded`, `controls`,
`tone`, and `size: "routine" | "primary"`. Forward refs and ordinary button
attributes. Emit a real `button type="button"`, explicit `aria-label`, and
`aria-hidden` on decorative icons. Stateful actions use appropriate pressed or
expanded attributes. A tooltip is supplementary help, never the button's name.
Do not add a generic div-button or give every SVG a competing name.

Use min-width/min-height from final target tokens and allow text buttons to wrap
and grow. Compact density cannot reduce the 32px routine target. Destructive
actions require their existing confirmation and state guards. Disabled controls
keep a readable nearby reason; do not make the reason accessible only through a
disabled element's hover tooltip. Busy Stop says **Stopping…** and remains visible
until the actual terminal acknowledgement, as the runtime contract already requires.

Make controls visible on keyboard focus and focus-within, not hover only. Retain
the existing DOM/mount economy for resting tiles. Focus changes must not remount
the conversation, submit a draft or start an auth/provider request. Use real
button labels for Stop, microphone, Retry turn, Save to project memory, Copy code,
Close conversation and menu actions. Verify the final accessibility tree rather
than assuming `aria-describedby` supplies a name. See [W3C name/role/value](https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html).

The proposed 32/36px product target is intentionally above W3C's 24 CSS-pixel
minimum with exceptions; do not describe 32px as the standard itself.
[W3C target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)
is the normative background for the DOM tests. Focus must remain visible and not
hidden behind sticky footers/dialogs: [W3C focus not obscured](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html).

### V7 stable, resizable sidebar

Keep the UX owner's project grouping, search, selection, contextual New and state
labels. Appearance owns geometry and rendering only. Share one sidebar width
preference; do not add a width per project or copy pins/project labels into it.

Default to 300px, drag range 240–480px in CSS pixels. A sibling separator has an
8px pointer hit area and a visible 2px grip on hover/focus. Use pointer capture,
release on pointerup/cancel, and one measured layout update per animation frame.
Persist the final width on release, not every pointermove. A keyboard separator
uses role `separator`, orientation `vertical`, a descriptive name and min/max/now
values. ArrowLeft/Right adjust by 8px; Shift+arrow by 32px; Home/End select bounds.
Double-click resets width to 300px; provide the same named reset via keyboard/menu.
Keep the reading direction explicit when calculating deltas. Follow the
[W3C window splitter pattern](https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/)
as guidance; the pattern itself notes that its example is incomplete, so real
keyboard/screen-reader testing remains required.

Render a row with a stable main selection button plus a separate 32px overflow
button, not three tiny hover actions. Put Pin, Archive/Restore and Delete in that
menu, preserving their current confirmations and ownership. Keep a visible pinned
marker. A second metadata line can carry timestamp and meaningful state; it does
not disappear when focus moves to actions. Comfortable two-line rows have a 48px
base minimum; compact rows 40px. Do not nest interactive buttons inside the row's
selection button. Show the complete title on an accessible disclosure/tooltip
that includes the title, not just provider/status. Group labels wrap or reveal
their complete project/host identity without opening a chat.

Let `A` be available Agents-view width after the app rail. Render inline sidebar
only when `A >= renderedSidebarWidth + max(320, 320*S) + 8`. Otherwise use a
transient drawer opened by **Show conversations**; do not compress the chat to
200px to preserve a sidebar. Drawer width is `min(savedWidth, A - 24px)` and does
not rewrite the saved preference. Trap focus while open, mark the covered main
surface inert, dismiss on Escape/backdrop, and return focus to its opener. Closing
it changes no active task. On window growth, preserve the saved width. Do not
automatically hide an open approval or change the selected conversation.

### V8 narrow header and execution context

Use an outer tile container with child header/context/content wrappers. Replace
the fixed 33px header with `min-height` based on the scaled routine target plus
vertical padding. Permit two rows when needed. Keep title, a **textual** status,
attention action/count, conversation menu and Close accessible; secondary items
can move into the menu. A status dot alone is not the replacement for Running,
Needs you or Failed. Use the UX owner's attention command to reveal the exact
blocker; do not add a second attention dispatcher.

At 680px and above, show host, project, branch and context usage on available
rows. At 480–679px, allow context to wrap with host first. Below 480px, keep a
focusable **Execution context** disclosure showing at least **Local** or
**SSH: host** and the current permission posture, with full project path, branch,
worktree and MCP details in a keyboard-accessible popover. Its fields are real
text that can be selected/copied. Use saved conversation/execution target data,
not global selectedRepo. Never remove host identity to make more model text fit.
The disclosure is a read-only projection; it cannot modify execution authority.

Use explicit button semantics for disclosure, labelled dialog/popover content,
Escape and focus return. Tooltips on nonfocusable spans are insufficient for
required context. Do not put required context only in a clipped row. Long host
names and paths wrap using `overflow-wrap:anywhere` in the expanded details;
only short visual summaries truncate.

At 320px, and at the 44px reading extreme, content/control groups stack vertically.
Keep Send/Stop reachable in their own action row, with full error/permission text
above rather than hidden below a fixed-height composer. Preserve existing drafts,
IME behavior, focus, pending approvals and disabled reasons. The UX owner handles
behavioral repairs in these shared files first; V8 applies layout afterwards.

## Implementation packets and ownership

All packets are future work. A packet owns only its declared files during its
implementation window; tests may have matching owned files. The integrator must
serialize shared files rather than ask agents to edit them concurrently.

| Packet | Concrete deliverable and owned seams                                                                                                                                                                                                                                                                                                                                          | Depends on / exit proof                                                                                                                                                                                                                |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **V1** | Pure `lib/appearance.ts` metrics/types, appearance CSS tokens, `index.css`, `tailwind.config.ts`; semantic utility mapping and owned consumer inventory. Preserve Inter. Reading, metadata, code, headings and compatibility utilities use one scale.                                                                                                                         | Coordinate global contract first. Pure metric cases and computed-style fixtures show exact values, no sub-12px ordinary defaults, no duplicate multiplier. No global selector alters xterm.                                            |
| **V2** | Theme palette in `index.css` / token declarations; contrast fixture under `lib/__tests__`; actual-state checks for menus, settings, permissions, review and Flights.                                                                                                                                                                                                          | V1 tokens stable. All informative text pairs >=4.5 unrounded; required indicators >=3. Alpha states are measured, not inferred from the solid table.                                                                                   |
| **V3** | `stores/appearanceStore.ts`, `hooks/useApplyAppearance.ts`, `hooks/useAppearanceShortcuts.ts`, Appearance Settings card; additive terminalSettingsStore.terminalFontSizePx and live consumers useXterm.ts / TransientPtyModal.tsx; coordinated root edits to `App.tsx`, `MonitorApp.tsx`, `CommandPalette.tsx`, `settingsNavigation.ts`, platform and keyboard settings help. | V1 resolver fixed. Boot/malformed/version/storage-failure/reset/Monitor tests pass. Terminal 13→26px and bounds/shell preservation pass. Single shortcut handler, no provider/session work. Theme and tool-detail ownership unchanged. |
| **V4** | `common/MarkdownRenderer.tsx`, proposed `lib/syntaxTheme.ts`, scoped Markdown CSS; typography-only consumers for tool output and `agents/diff/DiffRows.tsx` after review-owner handoff.                                                                                                                                                                                       | V1/V2. Both themes and multiple languages/code lengths render at measured token sizes. Inline/fenced/copy/diff code agree; copy/selection retained.                                                                                    |
| **V5** | `ui/IconButton.tsx` and shared Button/Dropdown target variants; migrate owned icon-button consumers after UX changes settle.                                                                                                                                                                                                                                                  | V1. Computed target bounding boxes at each scale; compact retains target minima; destructive state guards unchanged.                                                                                                                   |
| **V6** | Icon action labels/focus/visibility in `Tooltip.tsx`, Markdown copy, message footer, header and shared action consumers. Tooltip remains a description primitive.                                                                                                                                                                                                             | V5 primitive plus V2 focus color. Accessibility-tree names, keyboard order, focus reveal/return and disabled reasons verified. No hover-only essential action.                                                                         |
| **V7** | `AgentSidebar.tsx` and proposed `AgentSidebarResizeHandle.tsx`; width binding in `AgentsView.tsx`, using V3 store.                                                                                                                                                                                                                                                            | UX grouping/search/navigation/sidebar commits **before** this packet; V1/V3/V5/V6 primitives stable. Pointer, keyboard, width persistence, narrow drawer and long-title checks pass.                                                   |
| **V8** | `AgentChatPane.tsx`, `chat/TileHeaderActions.tsx`, `composer/ContextStrip.tsx`, `composer/Composer.tsx`, `conversation-tile.css`; coordinated typography-only Flight/review layout follow-up.                                                                                                                                                                                 | UX draft/launch/attention/review contracts merged **before** edits to shared files. V1–V7 primitives stable. 320/480/680px, all themes/scales, review/Flight and native proof complete.                                                |

V1/V2/V3 can be prepared in separate nonoverlapping files after interfaces are
fixed, but `index.css`/Tailwind root integration is a single owner's mutation.
Do not run a mass formatting sweep. UX and V workers must explicitly hand off
`AgentSidebar.tsx`, `AgentsView.tsx`, `Composer.tsx`, `ContextStrip.tsx`,
`AgentChatPane.tsx`, header actions, message list and review wrappers. No packet
edits Flight or agent execution stores, backend DTOs, provider transports,
permission policy, lifecycle rules or authentication.

## Verification and failure examples

Tests below are acceptance work for implementation, not tests executed for this
document. Add DOM-dependent Vitest files under the configured DOM globs; do not
weaken production window guards to run them in Node.

1. **Pure/store tests:** all scale steps, compact/comfortable, B=13/15/22;
   exact 30/44px extremes; invalid fields/newer versions; one-key migration;
   write failure/retry; reset scope; monitor update performs zero writes;
   theme/tool detail/terminal size remain unchanged. Scale changes must never
   call any launch/send/resume/cancel/provider/auth or Flight mutation seam.
2. **Computed browser styles:** real CSS build, not jsdom alone. Sample body,
   composer, metadata, chip, headings, syntax code, diff line, table, settings
   navigation, warning, Flight outcome and menu. Assert font family/size/weight,
   line-height and final target sizes. A passing class-name assertion is not
   proof that SyntaxHighlighter inline styles lost the cascade.
3. **Contrast:** compute every semantic text/surface pair in both themes plus
   actual composed accent/hover/selected/focus states. Include thinking, usage,
   timestamps, placeholders, syntax comments, errors, review additions/deletions
   and Flight accepted/failed/retained states. Never round a 4.499 ratio into a pass.
4. **DOM/a11y:** query action names/roles/states, tab sequence, visible focus,
   pointer target rectangles, context disclosure, sidebar separator and drawer
   focus return. Test keyboard Copy without hovering the code block. Screen-reader
   checking complements rather than substitutes for DOM assertions.
5. **Responsive browser matrix:** tile widths 320/480/680px; both themes; both
   densities; App scale 100/125/150/200%; reading base 13/15/22. The complete
   geometry matrix is cheap with local deterministic fixtures. Include default
   200%=30px and extreme 22+200%=44px, as well as a separate browser zoom/text
   enlargement check. No horizontal page overflow for prose or controls; contained
   code/diff/table scrolling is allowed where the data needs two dimensions.
6. **User text-spacing overrides:** apply line height 1.5×, paragraph spacing
   2×, letter spacing .12em and word spacing .16em without losing controls/content.
   These are user override stress values from [W3C text spacing](https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html),
   not mandatory default styling. Fixed-height header/row/card assumptions must
   not clip the result. The app's own scale supports 200% all-nonterminal text
   enlargement; [W3C resize text](https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html)
   and [reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html) define why
   200% and 320 CSS-pixel stress cases matter.
7. **Native Windows:** record actual app/source/executable hash, WebView2
   version, window size and OS display scale (100/125/150/200% available cases).
   Run default, App scale 200%, and 22+200% at 320/480/680 tile widths. Check
   keyboard chords do not also zoom the webview, terminal input stays intact,
   NVDA/Narrator names/focus, font fallback and scrolling. OS scaling is external
   to S; do not multiply CSS sizes by it again.
8. **Native Mac:** record actual app/source/build hash, macOS/WKWebView version,
   display configuration and available Retina/non-Retina conditions. Repeat the
   representative extremes, Cmd shortcuts, VoiceOver names/focus, copy, fallback
   and CJK composition. Do not claim this passed from Chromium emulation, Apple
   documentation, or a Windows screenshot. Unavailable hardware is an explicitly
   unverified release condition, not a simulated pass.
9. **Workspace terminal:** store regressions prove old shell-only settings still
   load, default 13/malformed fallback, 10/32 bounds, font reset and shell-field/key
   preservation. While a PTY is active, change App scale and confirm
   `xterm.options.fontSize` is unchanged; resize layout without blank/zero-size
   frames. Use Terminal text size 13→26 to enlarge the default 200%; also test 32.
   Verify fit, cursor, selection, WebGL fallback, shell input, terminal dialogs and
   an inactive workspace restored to view. Assert zero terminal/PTY remounts or
   unintended input; font size changes leave App scale and reading base unchanged.

Required fixtures and examples:

- Two long, nearly identical conversation titles ending in different task IDs;
  timestamps remain visible when opening the row menu. Keyboard F2 rename still
  acts on the same conversation after resizing/grouping.
- An SSH target `build-host-with-a-long-name.example.invalid`, repository and
  worktree paths containing spaces, a long branch, and a permission request.
  At 320px, **SSH** and permission posture remain visible; expanded context shows
  exact saved paths. No real user host, credential or private path is required.
- A long auth/model/permission error; a failed retained Flight with **Continue
  preserved work**, a reviewer failure with Retry, and ready-to-land delivery.
  Disabled reasons wrap and remain adjacent to their actions. No action disappears
  because a card has a fixed height or header grows to two lines.
- Review with 120-character paths, large line numbers, long unbroken code,
  staged/unstaged changes, comments and approval arriving while review is open.
  At narrow widths, prefer the UX owner's unified/stacked review presentation;
  do not force side-by-side panes or cover the approval with the review footer.
  Viewed markers, exact attention focus, review position and acceptance guards
  retain their existing semantics.
- Flights list/detail, launch brief, attempt decision confirmation and archive
  confirmation at a minimum-size 800×600 window and at enlarged text. Keep target,
  branch, review result, retained-work warning and Land/Discard consequences
  readable. Do not change runtime guards merely to fit labels.
- English, CJK, Arabic/RTL, mixed code punctuation `Il1O0{}[]()`, emoji, accented
  text and multiline selection. Keep available bundled glyphs; record actual
  fallback fonts and any missing glyphs instead of assuming identical OS metrics.
- Long virtualized transcript: scale/density changes retain the current message
  anchor, drafts and attachments, do not jump to latest unless already pinned,
  and do not reinstall API listeners or reinitialize a session.

If 44px text at 320px exposes a problem, allow vertical stacking and scrolling,
not smaller text, hidden errors or permission changes. If a long code line needs
horizontal scrolling, confine it to the code region and keep surrounding actions
reachable. If the sidebar cannot coexist, use its drawer rather than deleting
context or reducing the reading scale silently.

## Rollout, evidence and reversal

Land metrics/store and shared primitives before consumer layout migrations, then
serialize UX/V consumer edits. Keep every packet reviewable; update the root
contract registry when a signature changes. The integration owner inventories
remaining raw sizes and documents the chosen consumer migration scope. Do not
claim V1/V3 complete while Settings, attention, review or Flight actions bypass
the App-scale contract. Full gates and native acceptance run only after the
source freeze coordinated by the integrator; individual packets use focused
tests and scoped checks first.

For each verification record, save synthetic fixtures, actual computed styles,
contrast output, keyboard/a11y results and screenshots at stated dimensions.
Record pass/fail/unavailable separately. There is no percentage “Codex parity”
claim. Do not start paid agents or change provider credentials to test appearance.
The previous quality-gate results do not validate this unimplemented proposal.

Preference rollout applies comfortable defaults to users without the new key and
retains existing explicit V1 preferences. Settings offers compact deliberately;
there is no automatic detection that restores tiny legacy typography. Keep the
new key forward-compatible and restricted to appearance. A code rollback must
leave the key in place so returning to the newer build preserves user choices.
Do not clear localStorage, restore a whole profile, reset theme/terminal settings,
or mutate conversations to undo a layout change.

If a token/palette regression is found, revert that implementation packet and its
dependent consumer styling together, preserving behavior/runtime commits and
preferences. If a stored oversized layout blocks navigation, Ctrl/Cmd+0 or the
named App-scale reset restores 100%; **Reset text and layout** additionally
restores the 15px reading base, comfortable density and 300px sidebar. Provide
these recovery actions before enabling scale above 100%. Document any known Mac
or terminal limitation explicitly rather than declaring a successful rollout.
