import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as mirror from "@/lib/storageMirror";
import { storageKey } from "@/lib/brand";
import { loadFromStorage, saveToStorage } from "@/lib/storage";

/**
 * The durable side of the world: a stand-in for
 * `~/.packetbench/webview-storage-mirror.json`.
 *
 * The whole point of that file is that it lives in the user's home directory
 * rather than under the bundle identifier, so it survives an identifier change
 * that wipes `localStorage`. In these tests it therefore lives *outside* the
 * module registry and is deliberately NOT reset when modules or `localStorage`
 * are — that asymmetry is what makes the migration proof below meaningful.
 */
const disk = vi.hoisted(() => ({
  file: null as Record<string, string> | null,
  loadCalls: 0,
  saveCalls: 0,
  failLoad: false,
  failSave: false,
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    loadWebviewStorageMirror: async () => {
      disk.loadCalls++;
      if (disk.failLoad) throw new Error("mirror unreadable");
      return disk.file ? { ...disk.file } : {};
    },
    saveWebviewStorageMirror: async (entries: Record<string, string>) => {
      disk.saveCalls++;
      if (disk.failSave) throw new Error("mirror unwritable");
      disk.file = { ...entries };
    },
  };
});

/**
 * Modelling an app relaunch.
 *
 * `stopStorageMirror()` resets every piece of mutable state the module owns —
 * the interception patch, the debounce timer, and the last-flushed bookkeeping
 * — so a stop/boot pair is behaviourally identical to a fresh process, without
 * paying for a `vi.resetModules()` re-import of the whole `@/lib/tauri` graph
 * on every test. (Doing that per test cost ~17s in this one file and starved
 * neighbouring test files of their timeout budget.)
 */
async function freshMirrorModule() {
  mirror.stopStorageMirror();
  return mirror;
}

function resetDisk() {
  disk.file = null;
  disk.loadCalls = 0;
  disk.saveCalls = 0;
  disk.failLoad = false;
  disk.failSave = false;
}

beforeEach(() => {
  resetDisk();
  localStorage.clear();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke: () => {} };
});

afterEach(() => {
  mirror.stopStorageMirror();
  vi.useRealTimers();
  localStorage.clear();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

// ---------------------------------------------------------------------------
// The migration proof
// ---------------------------------------------------------------------------

describe("bundle-identifier change", () => {
  /**
   * The actual defect, reproduced end to end.
   *
   * Tauri derives the webview profile directory — and therefore the origin
   * backing `localStorage` — from the bundle identifier. Renaming
   * `com.packetade.desktop` to `com.packetbench.desktop` swapped in a brand new
   * empty store. The `stopStorageMirror()` + `localStorage.clear()` pair below
   * is that event: the origin's contents are gone and the app boots from
   * scratch, while the home-directory mirror (`disk`) is untouched.
   *
   * State is written three different ways on purpose, because they are three
   * genuinely different code paths in the app:
   *   - `saveToStorage`, the `src/lib/storage.ts` seam (29 importers),
   *   - a raw `localStorage.setItem`, as ~25 component/store call sites do,
   *   - Zustand's `persist` middleware, which bypasses the seam entirely and
   *     is how `issueFlightMirrorStore` and `packetAgentStore` persist.
   */
  it("recovers state written under the old identifier after the store is wiped", async () => {
    // ---- Launch #1, under the OLD bundle identifier -----------------------
    const first = await freshMirrorModule();
    expect((await first.bootStorageMirror()).active).toBe(true);

    saveToStorage(storageKey("prompt-templates"), [{ id: "t1", body: "hello" }]);
    localStorage.setItem(storageKey("workspace-active-id"), JSON.stringify("ws-42"));

    const makePersistStore = async () => {
      const { create } = await import("zustand");
      const { persist } = await import("zustand/middleware");
      return create<{ label: string; setLabel: (v: string) => void }>()(
        persist((set) => ({ label: "", setLabel: (label: string) => set({ label }) }), {
          name: storageKey("proof-persist-store"),
        }),
      );
    };
    (await makePersistStore()).getState().setLabel("written-before-the-rename");

    await first.flushStorageMirrorNow();

    const mirrored = { ...disk.file };
    expect(Object.keys(mirrored)).toEqual(
      expect.arrayContaining([
        storageKey("prompt-templates"),
        storageKey("workspace-active-id"),
        storageKey("proof-persist-store"),
      ]),
    );

    // ---- The rename: a new identifier means a new, empty origin ----------
    first.stopStorageMirror();
    localStorage.clear();
    expect(localStorage.getItem(storageKey("prompt-templates"))).toBeNull();
    // ...but the home-directory mirror is untouched by the identifier change.
    expect(disk.file).toEqual(mirrored);

    // ---- Launch #2, under the NEW bundle identifier ----------------------
    const second = await freshMirrorModule();
    const result = await second.bootStorageMirror();

    expect(result.active).toBe(true);
    expect(result.restored).toBe(Object.keys(mirrored).length);

    // Plain reads are whole again...
    expect(loadFromStorage(storageKey("prompt-templates"), null)).toEqual([
      { id: "t1", body: "hello" },
    ]);
    expect(loadFromStorage(storageKey("workspace-active-id"), null)).toBe("ws-42");

    // ...and so is a Zustand `persist` store, which rehydrates from
    // `localStorage` when it is created — i.e. at app boot, after the restore.
    expect((await makePersistStore()).getState().label).toBe("written-before-the-rename");
  });

  /**
   * The two stores that bypass the `src/lib/storage.ts` seam are covered by
   * construction: the mirror snapshots the `packetbench:*` keyspace rather than
   * hooking the seam, so anything Zustand's `persist` middleware writes is
   * picked up with no per-store wiring. This pins that down against the real
   * store modules, so renaming or re-keying either one cannot quietly drop it
   * out of the mirror.
   */
  it("covers the Zustand-persist stores that bypass the storage seam", async () => {
    await freshMirrorModule();
    await mirror.bootStorageMirror();

    const { useIssueFlightMirrorStore } = await import("@/stores/issueFlightMirrorStore");
    const { usePacketAgentStore } = await import("@/stores/packetAgentStore");

    useIssueFlightMirrorStore.getState().enable("flight-1", {
      hostConnectionId: "gh",
      owner: "acme",
      repo: "widgets",
    });
    // Touch the other persist store so it writes its key out too.
    usePacketAgentStore.setState({});
    usePacketAgentStore.persist.rehydrate();

    await mirror.flushStorageMirrorNow();

    expect(disk.file).not.toBeNull();
    expect(Object.keys(disk.file ?? {})).toEqual(
      expect.arrayContaining([storageKey("issue-flight-mirrors"), storageKey("packet-agent")]),
    );
    expect(disk.file?.[storageKey("issue-flight-mirrors")]).toContain("flight-1");
  });
});

// ---------------------------------------------------------------------------
// Restore semantics
// ---------------------------------------------------------------------------

describe("restore", () => {
  it("fills an empty store from the mirror", async () => {
    disk.file = {
      "packetbench:issues": '{"issues":[]}',
      "packetbench:routing": '{"mode":"auto"}',
    };

    await freshMirrorModule();
    const result = await mirror.bootStorageMirror();

    expect(result).toMatchObject({ active: true, restored: 2, reason: null });
    expect(localStorage.getItem("packetbench:issues")).toBe('{"issues":[]}');
    expect(localStorage.getItem("packetbench:routing")).toBe('{"mode":"auto"}');
  });

  it("never clobbers a key the live store already has", async () => {
    disk.file = {
      "packetbench:issues": '{"issues":["stale-from-the-mirror"]}',
      "packetbench:routing": '{"mode":"auto"}',
    };
    localStorage.setItem("packetbench:issues", '{"issues":["live-and-newer"]}');

    await freshMirrorModule();
    const result = await mirror.bootStorageMirror();

    // Only the genuinely missing key was filled.
    expect(result.restored).toBe(1);
    expect(localStorage.getItem("packetbench:issues")).toBe('{"issues":["live-and-newer"]}');
    expect(localStorage.getItem("packetbench:routing")).toBe('{"mode":"auto"}');
  });

  it("ignores mirror entries outside the packetbench namespace", async () => {
    disk.file = {
      "packetbench:routing": "{}",
      "someone-elses:key": "nope",
    };

    await freshMirrorModule();
    expect((await mirror.bootStorageMirror()).restored).toBe(1);
    expect(localStorage.getItem("someone-elses:key")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Failure modes
// ---------------------------------------------------------------------------

describe("warm-origin project history", () => {
  const historyKey = storageKey("project-history");

  it("unions both origins before hydration and keeps that union in the initial mirror flush", async () => {
    const live = [
      { path: "/warm-only", lastOpened: 40 },
      { path: "/shared", lastOpened: 20 },
    ];
    const durable = [
      { path: "/baseline-only", lastOpened: 30 },
      { path: "/shared", lastOpened: 50 },
    ];
    disk.file = {
      [historyKey]: JSON.stringify(durable),
      [storageKey("settings")]: '{"theme":"old"}',
      [storageKey("routing")]: '{"mode":"auto"}',
      "unrelated:key": "leave outside the origin",
    };
    const settings = ' { "theme": "current", "privacy": "current" } ';
    localStorage.setItem(historyKey, JSON.stringify(live));
    localStorage.setItem(storageKey("settings"), settings);
    localStorage.setItem("unrelated:key", "live unrelated value");
    await freshMirrorModule();
    const result = await mirror.bootStorageMirror();
    const expected = [
      { path: "/shared", lastOpened: 50 },
      { path: "/warm-only", lastOpened: 40 },
      { path: "/baseline-only", lastOpened: 30 },
    ];
    expect(JSON.parse(localStorage.getItem(historyKey)!)).toEqual(expected);
    expect(result.restored).toBe(2);
    await mirror.flushStorageMirrorNow();
    expect(JSON.parse(disk.file![historyKey])).toEqual(expected);
    expect(localStorage.getItem(storageKey("settings"))).toBe(settings);
    expect(disk.file![storageKey("settings")]).toBe(settings);
    expect(localStorage.getItem(storageKey("routing"))).toBe('{"mode":"auto"}');
    expect(localStorage.getItem("unrelated:key")).toBe("live unrelated value");
    expect(disk.file!["unrelated:key"]).toBeUndefined();
  });

  it("uses maximum timestamps for duplicates while preserving case and separators as distinct paths", async () => {
    localStorage.setItem(
      historyKey,
      JSON.stringify([
        { path: "C:/Repo", lastOpened: 10 },
        { path: "/same", lastOpened: 80 },
        { path: "/same", lastOpened: 20 },
        { path: "/local-tie", lastOpened: 50 },
      ]),
    );
    disk.file = {
      [historyKey]: JSON.stringify([
        { path: "C:/Repo", lastOpened: 70 },
        { path: "c:/repo", lastOpened: 60 },
        { path: "C:\\Repo", lastOpened: 50 },
        { path: "/same", lastOpened: 30 },
      ]),
    };
    await freshMirrorModule();
    await mirror.bootStorageMirror();
    expect(JSON.parse(localStorage.getItem(historyKey)!)).toEqual([
      { path: "/same", lastOpened: 80 },
      { path: "C:/Repo", lastOpened: 70 },
      { path: "c:/repo", lastOpened: 60 },
      { path: "/local-tie", lastOpened: 50 },
      { path: "C:\\Repo", lastOpened: 50 },
    ]);
  });

  it.each([
    "not JSON",
    "{}",
    "[null]",
    '[{"path":"/bad","lastOpened":"new"}]',
    '[{"path":"","lastOpened":1}]',
    '[{"path":"/bad","lastOpened":1e999}]',
  ])("keeps the valid history copy when either input is malformed: %s", async (malformed) => {
    const valid = JSON.stringify([{ path: "/valid", lastOpened: 1 }]);
    for (const [live, durable] of [
      [malformed, valid],
      [valid, malformed],
    ]) {
      mirror.stopStorageMirror();
      localStorage.clear();
      localStorage.setItem(historyKey, live);
      disk.file = { [historyKey]: durable };
      await mirror.bootStorageMirror();
      expect(localStorage.getItem(historyKey)).toBe(valid);
      await mirror.flushStorageMirrorNow();
      expect(disk.file![historyKey]).toBe(valid);
    }
  });

  it("leaves the current value unchanged when neither history copy is valid", async () => {
    const current = "{current invalid";
    localStorage.setItem(historyKey, current);
    disk.file = { [historyKey]: "{mirror invalid" };
    await freshMirrorModule();
    expect((await mirror.bootStorageMirror()).restored).toBe(0);
    expect(localStorage.getItem(historyKey)).toBe(current);
  });

  it("does not rewrite an already merged history and restores a cold origin as before", async () => {
    const history = JSON.stringify([{ path: "/existing", lastOpened: 1 }]);
    disk.file = { [historyKey]: history };
    localStorage.setItem(historyKey, history);
    await freshMirrorModule();
    expect((await mirror.bootStorageMirror()).restored).toBe(0);
    mirror.stopStorageMirror();
    localStorage.clear();
    expect((await mirror.bootStorageMirror()).restored).toBe(1);
    expect(localStorage.getItem(historyKey)).toBe(history);
  });
});

describe("degradation", () => {
  it("is an inert no-op with no Tauri runtime", async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    disk.file = { "packetbench:routing": "{}" };

    await freshMirrorModule();
    const result = await mirror.bootStorageMirror();

    expect(result).toEqual({ active: false, restored: 0, reason: "no-tauri" });
    expect(mirror.isStorageMirrorActive()).toBe(false);
    expect(disk.loadCalls).toBe(0);

    // Ordinary storage use keeps working and never reaches the backend.
    localStorage.setItem("packetbench:routing", "{}");
    await expect(mirror.flushStorageMirrorNow()).resolves.toBeUndefined();
    expect(disk.saveCalls).toBe(0);
  });

  /**
   * A corrupt mirror surfaces as an empty read on the Rust side (the file is
   * quarantined and `{}` returned), so a *failed* read is the interesting case
   * here: it must leave the writer switched off. Otherwise a transient IPC
   * error on a fresh, empty origin would immediately flush an empty snapshot
   * over a perfectly good mirror and make the loss permanent.
   */
  it("stays passive when the mirror cannot be read, rather than overwriting it", async () => {
    disk.file = { "packetbench:issues": '{"issues":["precious"]}' };
    disk.failLoad = true;

    await freshMirrorModule();
    const result = await mirror.bootStorageMirror();

    expect(result).toMatchObject({ active: false, reason: "load-failed" });
    expect(mirror.isStorageMirrorActive()).toBe(false);

    // Writes on this origin do not reach the mirror...
    localStorage.setItem("packetbench:routing", "{}");
    await mirror.flushStorageMirrorNow();
    expect(disk.saveCalls).toBe(0);
    // ...so the good data is still there for the next launch to recover.
    expect(disk.file).toEqual({ "packetbench:issues": '{"issues":["precious"]}' });
  });

  it("recovers from a corrupt mirror by rebuilding it from the live store", async () => {
    // What the Rust side hands back after quarantining a corrupt file.
    disk.file = {};

    await freshMirrorModule();
    expect((await mirror.bootStorageMirror()).restored).toBe(0);

    localStorage.setItem("packetbench:routing", '{"mode":"auto"}');
    await mirror.flushStorageMirrorNow();

    expect(disk.file).toEqual({ "packetbench:routing": '{"mode":"auto"}' });
  });

  it("survives a failing save and retries on the next flush", async () => {
    await freshMirrorModule();
    await mirror.bootStorageMirror();

    disk.failSave = true;
    localStorage.setItem("packetbench:routing", "{}");
    await expect(mirror.flushStorageMirrorNow()).resolves.toBeUndefined();

    disk.failSave = false;
    await mirror.flushStorageMirrorNow();
    expect(disk.file).toEqual({ "packetbench:routing": "{}" });
  });

  it("restores the original Storage methods on teardown", async () => {
    const before = Storage.prototype.setItem;
    await freshMirrorModule();
    await mirror.bootStorageMirror();
    expect(Storage.prototype.setItem).not.toBe(before);

    mirror.stopStorageMirror();
    expect(Storage.prototype.setItem).toBe(before);
    expect(mirror.isStorageMirrorActive()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Write amplification
// ---------------------------------------------------------------------------

describe("write budget", () => {
  it("coalesces a burst of writes into a single flush", async () => {
    await freshMirrorModule();
    await mirror.bootStorageMirror();
    await mirror.flushStorageMirrorNow(); // settle the boot seed
    const baseline = disk.saveCalls;

    vi.useFakeTimers();
    for (let i = 0; i < 50; i++) {
      localStorage.setItem("packetbench:agent-drafts", JSON.stringify({ text: "x".repeat(i) }));
    }
    expect(disk.saveCalls).toBe(baseline);

    await vi.advanceTimersByTimeAsync(mirror.DEBOUNCE_MS + 10);
    vi.useRealTimers();
    await mirror.flushStorageMirrorNow();

    expect(disk.saveCalls).toBe(baseline + 1);
    expect(disk.file?.["packetbench:agent-drafts"]).toContain("x".repeat(49));
  });

  /**
   * The trailing debounce alone would let a sustained write stream (a store
   * that persists on every keystroke) defer the flush forever, so a crash
   * could lose an unbounded amount of work. The ceiling caps that window.
   */
  it("forces a flush once a sustained burst hits the debounce ceiling", async () => {
    await freshMirrorModule();
    await mirror.bootStorageMirror();
    await mirror.flushStorageMirrorNow();
    const baseline = disk.saveCalls;

    vi.useFakeTimers();
    // Write more often than DEBOUNCE_MS, so the trailing timer never elapses.
    const step = Math.floor(mirror.DEBOUNCE_MS / 2);
    const writes = Math.ceil(mirror.MAX_DEBOUNCE_MS / step) + 1;
    for (let i = 0; i < writes; i++) {
      localStorage.setItem("packetbench:agent-drafts", JSON.stringify({ n: i }));
      await vi.advanceTimersByTimeAsync(step);
    }
    vi.useRealTimers();

    expect(disk.saveCalls).toBeGreaterThan(baseline);
  });

  it("skips the round trip when nothing changed", async () => {
    await freshMirrorModule();
    await mirror.bootStorageMirror();
    localStorage.setItem("packetbench:routing", "{}");
    await mirror.flushStorageMirrorNow();
    const after = disk.saveCalls;

    await mirror.flushStorageMirrorNow();
    await mirror.flushStorageMirrorNow();
    expect(disk.saveCalls).toBe(after);
  });

  it("propagates deletions instead of resurrecting keys", async () => {
    await freshMirrorModule();
    await mirror.bootStorageMirror();
    localStorage.setItem("packetbench:routing", "{}");
    localStorage.setItem("packetbench:modules", "[]");
    await mirror.flushStorageMirrorNow();

    localStorage.removeItem("packetbench:modules");
    await mirror.flushStorageMirrorNow();

    expect(disk.file).toEqual({ "packetbench:routing": "{}" });
  });

  it("drops oversized values instead of shipping them every flush", async () => {
    await freshMirrorModule();
    localStorage.setItem("packetbench:workspaces-cache", "x".repeat(mirror.MAX_VALUE_BYTES + 1));
    localStorage.setItem("packetbench:routing", "{}");

    const snapshot = mirror.snapshotMirroredKeys();
    expect(snapshot).toEqual({ "packetbench:routing": "{}" });
  });

  it("ignores keys outside the packetbench namespace", async () => {
    await freshMirrorModule();
    localStorage.setItem("unrelated-origin-key", "value");
    localStorage.setItem("packetade:routing", "legacy");
    localStorage.setItem("packetbench:routing", "{}");

    expect(mirror.snapshotMirroredKeys()).toEqual({ "packetbench:routing": "{}" });
  });

  it("does not react to sessionStorage writes", async () => {
    await freshMirrorModule();
    await mirror.bootStorageMirror();
    await mirror.flushStorageMirrorNow();
    const baseline = disk.saveCalls;

    sessionStorage.setItem("packetbench:routing", "{}");
    await mirror.flushStorageMirrorNow();

    expect(disk.saveCalls).toBe(baseline);
    expect(disk.file?.["packetbench:routing"]).toBeUndefined();
  });
});
