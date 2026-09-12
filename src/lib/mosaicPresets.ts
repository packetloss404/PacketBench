import type { MosaicNode, MosaicLayoutPreset } from "@/types/mosaic";
import type { MosaicSplitNode } from "react-mosaic-component";

/**
 * Local type-guard replicating react-mosaic-component's `isSplitNode` without
 * pulling the library's runtime into the entry chunk. A split node is an object
 * with a `direction` field; leaves are strings and tabs nodes lack `direction`.
 */
function isSplitNode(node: MosaicNode<string> | null): node is MosaicSplitNode<string> {
  return node != null && typeof node === "object" && "direction" in node;
}

/**
 * Tiles-per-row for each preset. Preset names are RxC, so the column count is
 * the second digit — that is the only number the layout actually needs, since
 * the row count falls out of how many panes there are.
 */
const PRESET_COLUMNS: Record<MosaicLayoutPreset, number> = {
  "1x1": 1,
  "1x2": 2,
  "2x1": 1,
  "2x2": 2,
  "2x3": 3,
  "3x2": 2,
};

/**
 * Build a mosaic n-ary tree for a given layout preset and ordered pane IDs.
 *
 * The leaves are ALWAYS exactly the given ids, once each. The previous version
 * addressed fixed slots through `paneIds[Math.min(i, len - 1)]`, so a pane
 * count the preset did not divide evenly repeated the last id (n=3 and n=5
 * rendered one pane TWICE — two `WorkspacePane` mounts, two PTYs auto-started
 * for one pane) and any count past the preset's capacity silently dropped
 * panes (n=7+ had tiles for only the first six). Rows are now chunked from the
 * real id list, so a short last row is short and a long list grows more rows.
 *
 * The root is always a split, even for a single pane. Appending a pane must
 * never change a surviving leaf's DEPTH — `MosaicRoot` flattens each split
 * into a keyed Fragment, so a re-nested leaf remounts and its PTY is killed
 * and restarted. Keeping a split at the root means {@link appendPane} can push
 * onto `children` without disturbing anything already there.
 */
export function buildPresetTree(preset: MosaicLayoutPreset, paneIds: string[]): MosaicNode<string> {
  if (paneIds.length === 0) throw new Error("Need at least one pane ID");

  const columns = PRESET_COLUMNS[preset] ?? 2;
  const rows: MosaicNode<string>[] = [];
  for (let i = 0; i < paneIds.length; i += columns) {
    const rowIds = paneIds.slice(i, i + columns);
    // A one-pane row is the bare leaf: a split wrapping a single child renders
    // identically (no splitter, full bounds) but adds a pointless level.
    rows.push(rowIds.length === 1 ? rowIds[0] : split("row", rowIds));
  }

  // One row of one pane still gets a root split, per the depth invariant above.
  if (rows.length === 1) {
    return typeof rows[0] === "string" ? split("row", [rows[0]]) : rows[0];
  }
  return split("column", rows);
}

/** Shorthand to create a split node with equal percentages. */
function split(direction: "row" | "column", children: MosaicNode<string>[]): MosaicNode<string> {
  return {
    type: "split" as const,
    direction,
    children,
  };
}

/**
 * Walk a mosaic tree depth-first, left-to-right, top-to-bottom.
 * Returns ordered leaf IDs — used for Ctrl+1/2/3/4 pane switching.
 */
export function getLeafOrder(tree: MosaicNode<string> | null): string[] {
  if (tree === null) return [];
  if (typeof tree === "string") return [tree];
  if (isSplitNode(tree)) {
    return tree.children.flatMap((child) => getLeafOrder(child));
  }
  // TabsNode — return all tabs
  if ("tabs" in tree) {
    return tree.tabs as string[];
  }
  return [];
}

/** Only mounted tiles are navigable: this library unmounts inactive tabs. */
export function getVisibleLeafOrder(tree: MosaicNode<string> | null): string[] {
  if (tree === null) return [];
  if (typeof tree === "string") return [tree];
  if (isSplitNode(tree)) return tree.children.flatMap(getVisibleLeafOrder);
  const active = tree.tabs[tree.activeTabIndex ?? 0];
  return active ? [active] : [];
}

export interface MosaicCanvasSize {
  width: number;
  height: number;
}

export const READABLE_PANE_SIZE: MosaicCanvasSize = { width: 360, height: 240 };

/** Minimum canvas needed to keep each visible tile readable at saved ratios.
 * Resizing the canvas leaves the tree and React mount identities untouched. */
export function readableMosaicSize(
  tree: MosaicNode<string> | null,
  paneSize = READABLE_PANE_SIZE,
): MosaicCanvasSize {
  if (tree === null) return { width: 0, height: 0 };
  if (typeof tree === "string" || !isSplitNode(tree)) return { ...paneSize };
  const sizes = tree.children.map((child) => readableMosaicSize(child, paneSize));
  const fractions = tree.children.map((_, index) =>
    Math.max((tree.splitPercentages?.[index] ?? 100 / tree.children.length) / 100, 0.01),
  );
  return {
    width: Math.ceil(
      Math.max(
        ...sizes.map((size, index) =>
          tree.direction === "row" ? size.width / fractions[index] : size.width,
        ),
      ),
    ),
    height: Math.ceil(
      Math.max(
        ...sizes.map((size, index) =>
          tree.direction === "column" ? size.height / fractions[index] : size.height,
        ),
      ),
    ),
  };
}

/** Equalize sizes without moving a leaf to a new parent/depth (a PTY restart). */
export function balanceMosaicSizes(tree: MosaicNode<string>): MosaicNode<string> {
  if (typeof tree === "string" || !isSplitNode(tree)) return tree;
  return {
    type: "split",
    direction: tree.direction,
    children: tree.children.map(balanceMosaicSizes),
  };
}

/**
 * Append a new pane to the tree without moving anything already in it.
 *
 * Replaces the old `addToTree`, which converted the last leaf into a nested
 * split. That pushed the surviving leaf down one level, and because
 * `MosaicRoot` renders each split as a Fragment keyed by path, the survivor
 * landed under a differently-keyed Fragment and React REMOUNTED it — running
 * `useTerminalSession`'s cleanup (`killPty`) and then auto-starting a fresh
 * PTY. Adding a terminal beside a working agent therefore restarted that
 * agent mid-task. It also degraded widths to 50/25/12.5/12.5, since every
 * addition nested one level deeper and always split as a row.
 *
 * Pushing onto the ROOT split's children instead leaves every existing leaf at
 * its exact depth and index. `splitPercentages` is dropped so `MosaicRoot`
 * falls back to even distribution across the new child count — a stale array
 * sized for the old count would misplace every boundary.
 */
export function appendPane(tree: MosaicNode<string>, newId: string): MosaicNode<string> {
  if (isSplitNode(tree)) {
    // Rebuilt field-by-field rather than spread, so `splitPercentages` is left
    // behind: a percentage array sized for the old child count would misplace
    // every boundary. Omitting it makes MosaicRoot distribute evenly.
    return { type: "split", direction: tree.direction, children: [...tree.children, newId] };
  }
  // A bare leaf or tabs node at the root: wrap it. This is the one case that
  // changes an existing leaf's depth, and `buildPresetTree` keeps a split at
  // the root precisely so the app never reaches it.
  return split("row", [tree, newId]);
}

/**
 * Remove a leaf from the tree. Returns null once the tree is empty.
 *
 * A split left with ONE child is deliberately kept rather than collapsed to
 * that bare child. Collapsing lifted the survivor a level, which — by the same
 * Fragment-keying described on {@link appendPane} — remounted it and restarted
 * its agent: closing the middle of three panes restarted the right-hand one.
 * A single-child split renders identically anyway (`MosaicRoot` emits no
 * splitter for the last child and gives it the full bounding box).
 */
export function removeFromTree(tree: MosaicNode<string>, id: string): MosaicNode<string> | null {
  if (typeof tree === "string") {
    return tree === id ? null : tree;
  }

  if (!isSplitNode(tree)) return tree;

  const newChildren = tree.children
    .map((child) => removeFromTree(child, id))
    .filter((child): child is MosaicNode<string> => child !== null);

  if (newChildren.length === 0) return null;

  // Percentages must only be dropped by the split that actually LOST a child —
  // its array is now the wrong length. Rebuilding every split on the way back
  // up discarded them everywhere, so closing one tile snapped every other
  // splitter in the workspace to even, and (since the result is persisted) did
  // so permanently.
  if (newChildren.length === tree.children.length) {
    const unchanged = newChildren.every((child, i) => child === tree.children[i]);
    if (unchanged) return tree;
    // A descendant changed but this split's own child count did not, so its
    // boundaries are still meaningful — carry `splitPercentages` through.
    return { ...tree, children: newChildren };
  }

  return { type: "split", direction: tree.direction, children: newChildren };
}

/**
 * Structurally validate a mosaic tree read from an untrusted source (the
 * persisted workspace layout, which round-trips through Rust as opaque JSON
 * and through localStorage as a blind `JSON.parse`).
 *
 * Returns the tree only if every node is a shape `MosaicRoot` can render;
 * anything else degrades to `null`, and the caller falls back to the preset.
 * This is a SHAPE check only — leaf ids are reconciled against the real pane
 * list separately, by {@link reconcileLayout}.
 */
export function isValidMosaicTree(value: unknown): value is MosaicNode<string> {
  if (typeof value === "string") return value.length > 0;
  if (!value || typeof value !== "object") return false;
  const node = value as Record<string, unknown>;
  if (node.type === "split") {
    if (node.direction !== "row" && node.direction !== "column") return false;
    if (!Array.isArray(node.children) || node.children.length === 0) return false;
    // `MosaicRoot` feeds `splitPercentages` straight to `splitBoundingBox`, so
    // a non-array or a wrong-length array yields NaN geometry rather than a
    // visible error. Absent is fine — the library falls back to an even split.
    const percentages = node.splitPercentages;
    if (percentages !== undefined) {
      if (!Array.isArray(percentages)) return false;
      if (percentages.length !== node.children.length) return false;
      if (!percentages.every((p) => typeof p === "number" && Number.isFinite(p))) return false;
    }
    return node.children.every((child) => isValidMosaicTree(child));
  }
  if (node.type === "tabs") {
    // An EMPTY tabs node passes `[].every()` but renders a phantom tile that
    // still claims its share of the workspace, so it is rejected the same way
    // a childless split is.
    if (!Array.isArray(node.tabs) || node.tabs.length === 0) return false;
    if (!node.tabs.every((t) => typeof t === "string" && t)) return false;
    // `MosaicTabs` indexes `tabs[activeTabIndex]`.
    const active = node.activeTabIndex;
    if (active !== undefined) {
      if (typeof active !== "number" || !Number.isInteger(active)) return false;
      if (active < 0 || active >= node.tabs.length) return false;
    }
    return true;
  }
  return false;
}

/**
 * True when any split in the tree gives a child (near-)zero width.
 *
 * react-mosaic collapses a tile to 0% while it is being dragged, and emits a
 * release event in that state, so this is how a persist path tells "the user
 * finished arranging" from "a drag is in flight". A saved 0% pane would render
 * invisible with no obvious way to recover it.
 */
export function hasCollapsedSplit(tree: MosaicNode<string> | null): boolean {
  if (!tree || typeof tree !== "object") return false;
  if (!isSplitNode(tree)) return false;
  const percentages = tree.splitPercentages;
  if (Array.isArray(percentages) && percentages.some((p) => typeof p === "number" && p < 1)) {
    return true;
  }
  return tree.children.some((child) => hasCollapsedSplit(child));
}

/**
 * Fit a saved layout onto the panes that actually exist right now.
 *
 * A persisted layout is a CACHE of an arrangement, never the truth about which
 * panes exist — `workspace.panes` is. Between sessions panes get added, closed,
 * or dropped by `normalizePanes`, so the saved leaves and the real pane list
 * routinely disagree. Rather than discarding the user's arrangement whenever
 * they differ, prune leaves whose pane is gone and append panes the layout
 * never saw.
 *
 * Returns `null` when nothing usable survives, which tells the caller to build
 * from the preset instead. Guarantees the same invariant `buildPresetTree`
 * does: the leaves are exactly `paneIds`, once each.
 */
export function reconcileLayout(saved: unknown, paneIds: string[]): MosaicNode<string> | null {
  if (paneIds.length === 0) return null;
  if (!isValidMosaicTree(saved)) return null;

  const wanted = new Set(paneIds);
  const savedLeaves = getLeafOrder(saved);

  // `removeFromTree` removes EVERY occurrence of an id, so a duplicate cannot
  // be pruned selectively — the id is dropped wholesale here and re-appended
  // once below. (A saved layout can legitimately carry a duplicate: builds
  // before the `Math.min` fix wrote one at 3 and 5 panes.)
  const kept = new Set<string>();
  const drop = new Set<string>();
  for (const leaf of savedLeaves) {
    if (!wanted.has(leaf)) drop.add(leaf);
    else if (kept.has(leaf)) drop.add(leaf);
    else kept.add(leaf);
  }

  let tree: MosaicNode<string> | null = saved;
  for (const id of drop) {
    if (tree) tree = removeFromTree(tree, id);
  }
  // Everything the layout described is gone — there is no arrangement left to
  // honour, so the caller builds from the preset.
  if (!tree) return null;

  // Panes the saved layout never knew about — and any id dropped above purely
  // to de-duplicate it — join at the root.
  const present = new Set(getLeafOrder(tree));
  for (const id of paneIds) {
    if (!present.has(id)) tree = appendPane(tree, id);
  }

  // Final guarantee, matching `buildPresetTree`: leaves are exactly `paneIds`,
  // once each. Anything else would mount a pane twice or lose one, so refuse
  // the layout rather than render it.
  const leaves = getLeafOrder(tree);
  if (leaves.length !== paneIds.length || new Set(leaves).size !== paneIds.length) {
    return null;
  }
  return tree;
}

/**
 * Given an agent count, pick the best default preset.
 */
export function presetForCount(count: number): MosaicLayoutPreset {
  if (count <= 1) return "1x1";
  if (count === 2) return "1x2";
  if (count <= 4) return "2x2";
  if (count <= 6) return "3x2";
  return "3x2";
}
