/**
 * Host-OS detection for the webview.
 *
 * Tauri does not ship `@tauri-apps/plugin-os` in this app, so the two places
 * that already needed the host OS each rolled their own `navigator.userAgent`
 * regex (`DictationView.formatAccelerator`, `KeyboardShortcutsCard` — both
 * only asking "is this a Mac?" to label a modifier key). This module is the
 * place to add to rather than growing a third copy.
 *
 * Prefers `navigator.userAgentData.platform`, which WebView2 and Chromium
 * report as a clean `"Windows"` / `"macOS"` / `"Linux"`; falls back to the
 * user-agent string, which every runtime has. Both reads are wrapped because
 * a `navigator` can be absent or throwing in a test environment, and a
 * platform probe must never be the thing that takes a settings card down.
 */

interface UserAgentData {
  platform?: string;
}

function platformHint(): string {
  try {
    if (typeof navigator === "undefined") return "";
    const data = (navigator as Navigator & { userAgentData?: UserAgentData })
      .userAgentData;
    if (typeof data?.platform === "string" && data.platform.length > 0) {
      return data.platform;
    }
    return navigator.userAgent ?? "";
  } catch {
    return "";
  }
}

/** Whether the app is running on Windows. */
export function isWindows(): boolean {
  return /win/i.test(platformHint());
}

/** Whether the app is running on macOS. */
export function isMac(): boolean {
  return /mac/i.test(platformHint());
}
