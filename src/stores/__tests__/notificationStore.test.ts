import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useNotificationStore } from "../notificationStore";
import { notifyAttemptCompleted, notifyAttemptFailed } from "@/lib/notifications";

const STORAGE_KEY = "packetbench:notifications";
const store = () => useNotificationStore.getState();

describe("Flight notification preferences", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("honors global/event preferences and the focus policy before delivering", async () => {
    const notification = vi.fn(function () {});
    Object.defineProperty(notification, "permission", { value: "granted" });
    vi.stubGlobal("Notification", notification);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    useNotificationStore.setState({ enabled: false, onSessionComplete: true, onSessionError: true, onlyWhenUnfocused: false });
    await notifyAttemptCompleted("flight", "attempt");
    await notifyAttemptFailed("flight", "attempt");
    expect(notification).not.toHaveBeenCalled();
    useNotificationStore.setState({ enabled: true, onSessionComplete: false, onSessionError: false });
    await notifyAttemptCompleted("flight", "attempt");
    await notifyAttemptFailed("flight", "attempt");
    expect(notification).not.toHaveBeenCalled();
    useNotificationStore.setState({ onSessionComplete: true, onSessionError: true, onlyWhenUnfocused: true });
    await notifyAttemptCompleted("flight", "attempt");
    expect(notification).not.toHaveBeenCalled();
    useNotificationStore.setState({ onlyWhenUnfocused: false });
    await notifyAttemptCompleted("flight", "attempt");
    await notifyAttemptFailed("flight", "attempt");
    await notifyAttemptCompleted("flight", "attempt");
    expect(notification).toHaveBeenCalledTimes(2);
  });
});

describe("notificationStore", () => {
  beforeEach(() => {
    localStorage.clear();
    useNotificationStore.setState({
      enabled: true,
      onlyWhenUnfocused: true,
      onApprovalNeeded: true,
      onSessionComplete: true,
      onSessionError: true,
    });
  });

  it("has sensible defaults", () => {
    expect(store().enabled).toBe(true);
    expect(store().onlyWhenUnfocused).toBe(true);
    expect(store().onApprovalNeeded).toBe(true);
    expect(store().onSessionComplete).toBe(true);
    expect(store().onSessionError).toBe(true);
  });

  it("setEnabled updates state and persists", () => {
    store().setEnabled(false);
    expect(store().enabled).toBe(false);
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(raw.enabled).toBe(false);
  });

  it("setOnlyWhenUnfocused updates state and persists", () => {
    store().setOnlyWhenUnfocused(false);
    expect(store().onlyWhenUnfocused).toBe(false);
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(raw.onlyWhenUnfocused).toBe(false);
  });

  it("setOnApprovalNeeded updates state and persists", () => {
    store().setOnApprovalNeeded(false);
    expect(store().onApprovalNeeded).toBe(false);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).onApprovalNeeded).toBe(false);
  });

  it("setOnSessionComplete updates state and persists", () => {
    store().setOnSessionComplete(false);
    expect(store().onSessionComplete).toBe(false);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).onSessionComplete).toBe(false);
  });

  it("setOnSessionError updates state and persists", () => {
    store().setOnSessionError(false);
    expect(store().onSessionError).toBe(false);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).onSessionError).toBe(false);
  });

  it("multiple updates accumulate in persisted state", () => {
    store().setEnabled(false);
    store().setOnApprovalNeeded(false);
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(raw.enabled).toBe(false);
    expect(raw.onApprovalNeeded).toBe(false);
    expect(raw.onSessionComplete).toBe(true);
  });
});
