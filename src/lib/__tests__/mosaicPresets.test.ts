/**
 * Mosaic tree construction.
 *
 * There was no test file here at all, which is why two live defects survived:
 * `buildPresetTree` addressed fixed slots through `paneIds[Math.min(i, len-1)]`
 * (repeating the last id at n=3/n=5, dropping ids past n=6), and the add/remove
 * helpers re-nested surviving leaves (remounting them, which kills and
 * restarts their PTY).
 *
 * The load-bearing property is: **the leaves of any tree this module produces
 * are exactly the pane ids, once each.** A duplicate leaf mounts a pane twice
 * and auto-starts two PTYs for it; a missing leaf renders no tile for a pane
 * that exists and is billed for.
 */
import { describe, expect, it } from "vitest";
import type { MosaicNode } from "@/types/mosaic";
import {
  appendPane,
  buildPresetTree,
  getLeafOrder,
  hasCollapsedSplit,
  isValidMosaicTree,
  presetForCount,
  reconcileLayout,
  removeFromTree,
  readableMosaicSize,
  balanceMosaicSizes,
  getVisibleLeafOrder,
} from "@/lib/mosaicPresets";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `pane-${i}`);

describe("readable mosaic viewport", () => {
  it.each([1, 4, 8, 12])(
    "allocates readable dimensions for %i panes without changing the saved arrangement",
    (count) => {
      const tree = buildPresetTree(presetForCount(count), ids(count));
      const original = structuredClone(tree);
      const size = readableMosaicSize(tree);
      expect(size.width).toBe(count === 1 ? 360 : 720);
      expect(size.height).toBe(count === 1 ? 240 : Math.ceil(count / 2) * 240);
      expect(tree).toEqual(original);
    },
  );

  it("respects unequal saved ratios when sizing a scrollable canvas", () => {
    const tree: MosaicNode<string> = {
      type: "split",
      direction: "row",
      children: ["left", "right"],
      splitPercentages: [25, 75],
    };
    expect(readableMosaicSize(tree)).toEqual({ width: 1440, height: 240 });
    expect(
      readableMosaicSize({
        type: "split",
        direction: "column",
        children: [tree, "bottom"],
        splitPercentages: [60, 40],
      }),
    ).toEqual({ width: 1440, height: 600 });
  });

  it("balances sizes without moving or losing any live leaf", () => {
    const tree: MosaicNode<string> = {
      type: "split",
      direction: "row",
      splitPercentages: [70, 30],
      children: [
        { type: "split", direction: "column", children: ["a", "b"], splitPercentages: [25, 75] },
        "c",
      ],
    };
    const balanced = balanceMosaicSizes(tree);
    expect(getLeafOrder(balanced)).toEqual(getLeafOrder(tree));
    expect(leafDepths(balanced)).toEqual(leafDepths(tree));
    expect(JSON.stringify(balanced)).not.toContain("splitPercentages");
    expect(JSON.stringify(tree)).toContain("splitPercentages");
  });

  it("counts only a tab group's mounted pane for navigation and readable space", () => {
    const tabs: MosaicNode<string> = { type: "tabs", tabs: ["a", "b", "c"], activeTabIndex: 1 };
    expect(getVisibleLeafOrder(tabs)).toEqual(["b"]);
    expect(readableMosaicSize(tabs)).toEqual({ width: 360, height: 240 });
    expect(balanceMosaicSizes(tabs)).toBe(tabs);
  });
});

/** Depth of each leaf, keyed by id — the quantity that decides remounting. */
function leafDepths(tree: MosaicNode<string> | null, depth = 0): Record<string, number> {
  if (tree === null) return {};
  if (typeof tree === "string") return { [tree]: depth };
  if (typeof tree === "object" && "children" in tree) {
    return Object.assign({}, ...tree.children.map((child) => leafDepths(child, depth + 1)));
  }
  return {};
}

describe("buildPresetTree", () => {
  it("emits every pane id exactly once, at every count", () => {
    for (let n = 1; n <= 12; n++) {
      const input = ids(n);
      const leaves = getLeafOrder(buildPresetTree(presetForCount(n), input));
      expect([...leaves].sort(), `n=${n}`).toEqual([...input].sort());
    }
  });

  it("preserves pane order left-to-right, top-to-bottom", () => {
    for (let n = 1; n <= 12; n++) {
      const input = ids(n);
      expect(getLeafOrder(buildPresetTree(presetForCount(n), input)), `n=${n}`).toEqual(input);
    }
  });

  it("never duplicates a leaf at the counts that used to (n=3, n=5)", () => {
    for (const n of [3, 5]) {
      const leaves = getLeafOrder(buildPresetTree(presetForCount(n), ids(n)));
      expect(new Set(leaves).size, `n=${n}`).toBe(n);
    }
  });

  it("gives panes past the preset's capacity a tile (n=7, n=8)", () => {
    for (const n of [7, 8]) {
      const leaves = getLeafOrder(buildPresetTree(presetForCount(n), ids(n)));
      expect(leaves, `n=${n}`).toContain(`pane-${n - 1}`);
    }
  });

  it("keeps a split at the root even for one pane, so growth is a plain append", () => {
    const tree = buildPresetTree(presetForCount(1), ids(1));
    expect(typeof tree).toBe("object");
    expect(getLeafOrder(tree)).toEqual(["pane-0"]);
  });

  it("rejects an empty pane list rather than inventing a tree", () => {
    expect(() => buildPresetTree("2x2", [])).toThrow();
  });
});

describe("appendPane", () => {
  it("adds the pane and leaves every existing leaf at its original depth", () => {
    let tree = buildPresetTree(presetForCount(1), ids(1));
    let before = leafDepths(tree);

    for (let n = 2; n <= 8; n++) {
      tree = appendPane(tree, `pane-${n - 1}`);
      const after = leafDepths(tree);

      // The regression: nesting the last leaf to make room moved a running
      // pane, remounting it and restarting its agent mid-task.
      for (const [id, depth] of Object.entries(before)) {
        expect(after[id], `pane ${id} moved when growing to n=${n}`).toBe(depth);
      }
      expect(getLeafOrder(tree)).toEqual(ids(n));
      before = after;
    }
  });

  it("drops stale split percentages so the new child count divides evenly", () => {
    const tree = appendPane(
      { type: "split", direction: "row", children: ["a", "b"], splitPercentages: [70, 30] },
      "c",
    );
    expect(tree).not.toHaveProperty("splitPercentages");
  });
});

describe("removeFromTree", () => {
  it("removes only the named pane and never moves a survivor", () => {
    const tree = buildPresetTree(presetForCount(3), ids(3));
    const before = leafDepths(tree);

    const pruned = removeFromTree(tree, "pane-1");

    expect(getLeafOrder(pruned)).toEqual(["pane-0", "pane-2"]);
    const after = leafDepths(pruned);
    // Collapsing a now-single-child split used to lift the survivor a level,
    // restarting the right-hand pane when the middle one was closed.
    expect(after["pane-2"]).toBe(before["pane-2"]);
    expect(after["pane-0"]).toBe(before["pane-0"]);
  });

  it("keeps hand-set splitter positions on splits that did not lose a child", () => {
    const tree = {
      type: "split" as const,
      direction: "column" as const,
      splitPercentages: [60, 40],
      children: [
        {
          type: "split" as const,
          direction: "row" as const,
          splitPercentages: [70, 30],
          children: ["A", "B"],
        },
        {
          type: "split" as const,
          direction: "row" as const,
          splitPercentages: [25, 75],
          children: ["C", "D"],
        },
      ],
    };

    const out = removeFromTree(tree, "B") as {
      splitPercentages?: number[];
      children: { splitPercentages?: number[] }[];
    };

    // The regression: every split was rebuilt on the way back up, so closing
    // ONE tile snapped every splitter in the workspace to even — and, because
    // the result is persisted, permanently.
    expect(out.splitPercentages).toEqual([60, 40]);
    expect(out.children[1].splitPercentages).toEqual([25, 75]);
    // Only the split that actually lost a child drops its (now wrong-length)
    // array and falls back to an even distribution.
    expect(out.children[0].splitPercentages).toBeUndefined();
  });

  it("returns the identical node when nothing was removed", () => {
    const tree = buildPresetTree(presetForCount(2), ids(2));
    expect(removeFromTree(tree, "not-a-pane")).toBe(tree);
  });

  it("returns null once the last pane is gone", () => {
    const tree = buildPresetTree(presetForCount(1), ids(1));
    expect(removeFromTree(tree, "pane-0")).toBeNull();
  });

  it("leaves an unrelated id untouched", () => {
    const tree = buildPresetTree(presetForCount(4), ids(4));
    expect(getLeafOrder(removeFromTree(tree, "pane-99"))).toEqual(ids(4));
  });

  it("survives an add/remove churn cycle with the leaves still exact", () => {
    let tree: MosaicNode<string> | null = buildPresetTree(presetForCount(4), ids(4));
    tree = removeFromTree(tree!, "pane-1");
    tree = appendPane(tree!, "pane-4");
    tree = removeFromTree(tree!, "pane-0");
    tree = appendPane(tree!, "pane-5");

    const leaves = getLeafOrder(tree);
    expect([...leaves].sort()).toEqual(["pane-2", "pane-3", "pane-4", "pane-5"]);
    expect(new Set(leaves).size).toBe(4);
  });
});

describe("isValidMosaicTree", () => {
  it("accepts the shapes MosaicRoot can render", () => {
    expect(isValidMosaicTree("pane-0")).toBe(true);
    expect(isValidMosaicTree({ type: "split", direction: "row", children: ["a", "b"] })).toBe(true);
    expect(isValidMosaicTree({ type: "tabs", tabs: ["a", "b"] })).toBe(true);
  });

  it("rejects anything a blind JSON.parse could hand it", () => {
    for (const bad of [
      null,
      undefined,
      42,
      "",
      {},
      { type: "split" },
      { type: "split", direction: "diagonal", children: ["a"] },
      { type: "split", direction: "row", children: [] },
      { type: "split", direction: "row", children: ["a", { type: "nope" }] },
      { direction: "row", children: ["a", "b"] },
      // An empty tabs node passes `[].every()` but renders a phantom tile that
      // still claims its share of the workspace.
      { type: "tabs", tabs: [] },
      // splitPercentages goes straight to splitBoundingBox — a wrong length or
      // a non-number yields NaN geometry rather than a visible error.
      { type: "split", direction: "row", children: ["a", "b"], splitPercentages: [100] },
      { type: "split", direction: "row", children: ["a", "b"], splitPercentages: "x" },
      { type: "tabs", tabs: ["a"], activeTabIndex: 5 },
    ]) {
      expect(isValidMosaicTree(bad), JSON.stringify(bad) ?? "undefined").toBe(false);
    }
  });
});

describe("reconcileLayout", () => {
  const saved = buildPresetTree("2x2", ["pane-0", "pane-1", "pane-2", "pane-3"]);

  it("returns the saved arrangement unchanged when the panes still match", () => {
    const out = reconcileLayout(saved, ["pane-0", "pane-1", "pane-2", "pane-3"]);
    expect(getLeafOrder(out)).toEqual(["pane-0", "pane-1", "pane-2", "pane-3"]);
  });

  it("prunes leaves whose pane no longer exists", () => {
    const out = reconcileLayout(saved, ["pane-0", "pane-2"]);
    expect(getLeafOrder(out)).toEqual(["pane-0", "pane-2"]);
  });

  it("appends panes the saved layout never saw", () => {
    const out = reconcileLayout(saved, ["pane-0", "pane-1", "pane-2", "pane-3", "pane-9"]);
    expect([...getLeafOrder(out)].sort()).toEqual(
      ["pane-0", "pane-1", "pane-2", "pane-3", "pane-9"].sort(),
    );
  });

  it("drops a duplicated leaf rather than mounting a pane twice", () => {
    // A layout written by an older build could carry the Math.min duplicate.
    const dupe = { type: "split", direction: "row", children: ["a", "b", "b"] };
    const out = reconcileLayout(dupe, ["a", "b"]);
    expect(getLeafOrder(out)).toEqual(["a", "b"]);
  });

  it("falls back to the preset for a malformed or empty layout", () => {
    expect(reconcileLayout(undefined, ["a"])).toBeNull();
    expect(reconcileLayout({ nonsense: true }, ["a"])).toBeNull();
    expect(reconcileLayout(saved, [])).toBeNull();
  });

  it("returns null when no saved leaf survives, so the caller uses the preset", () => {
    // Every pane in the saved layout is gone: there is no arrangement left to
    // honour, so the preset is the honest answer rather than a tree rebuilt
    // out of appends in arbitrary order.
    expect(reconcileLayout("gone-pane", ["a", "b"])).toBeNull();
  });
});

describe("hasCollapsedSplit", () => {
  it("detects the 0%-wide tile react-mosaic produces mid-drag", () => {
    expect(
      hasCollapsedSplit({
        type: "split",
        direction: "row",
        splitPercentages: [0, 100],
        children: ["a", "b"],
      }),
    ).toBe(true);
  });

  it("finds a collapsed split nested below the root", () => {
    expect(
      hasCollapsedSplit({
        type: "split",
        direction: "column",
        children: [
          "a",
          { type: "split", direction: "row", splitPercentages: [0, 100], children: ["b", "c"] },
        ],
      }),
    ).toBe(true);
  });

  it("passes ordinary layouts, including ones with no percentages at all", () => {
    expect(hasCollapsedSplit(buildPresetTree("2x2", ids(4)))).toBe(false);
    expect(
      hasCollapsedSplit({
        type: "split",
        direction: "row",
        splitPercentages: [40, 60],
        children: ["a", "b"],
      }),
    ).toBe(false);
    expect(hasCollapsedSplit(null)).toBe(false);
  });
});
