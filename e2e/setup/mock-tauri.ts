/**
 * Tauri IPC mock for Playwright web-mode E2E tests.
 *
 * The frontend calls Tauri commands via `@tauri-apps/api`, which under the hood
 * calls `window.__TAURI_INTERNALS__.invoke(cmd, args)`. When running against the
 * Vite dev server in a normal browser those internals are absent, so every
 * invoke would throw and crash the React tree.
 *
 * This script is injected by Playwright via `page.addInitScript` before any
 * app code runs. It installs a minimal `__TAURI_INTERNALS__` shim that returns
 * safe defaults for the commands hit during smoke tests. Extend the
 * `handlers` map as new flows need coverage.
 */
export const mockTauriInitScript = `
(() => {
  let nextEventId = 1;
  const ignoredEvents = new Set([
    "monitor-window:focus-main",
    "provider-auth:changed",
    "sidecar-status:changed",
  ]);

  const ignoredEventPatterns = [
    /^api-agent:(chunk|thinking|thinking-stop|tool-start|tool-result|permission-request|pending-edit|edit-baseline|plan-block|tool-output-extended|turn-summary|done|error):/,
    /^dictation:(waveform|status|model-progress|error|warning|limit-reached)$/,
    /^flight:(cost-updated)$/,
    /^flight-chat:(chunk|done|error):/,
    /^pty:(output|exit|state):/,
    /^side-chat:(chunk|done|error)$/,
  ];

  function isIgnoredEvent(event) {
    return ignoredEvents.has(event) || ignoredEventPatterns.some((pattern) => pattern.test(event));
  }

  const persistedState = {
    version: 1,
    flights: [],
    issues: [],
    agents: [],
    settings: {
      maxParallelSessions: 3,
      milestoneGating: true,
      projectPath: "",
    },
    ui: {},
    workspaces: [],
    memoryEvents: [],
    memoryPatterns: [],
    servers: [],
  };

  const handlers = {
    "plugin:event|listen": (args) => {
      const event = args && args.event;
      if (!isIgnoredEvent(event)) {
        throw new Error("[mock-tauri] unhandled event listen: " + event);
      }
      return nextEventId++;
    },
    "plugin:event|unlisten": (args) => {
      const event = args && args.event;
      if (!isIgnoredEvent(event)) {
        throw new Error("[mock-tauri] unhandled event unlisten: " + event);
      }
      return null;
    },
    // Filesystem / project
    get_cwd: () => "",
    list_directory: () => [],
    list_project_files: () => [],
    // Git
    get_git_branch: () => null,
    get_git_status: () => ({ clean: true, staged: [], unstaged: [], untracked: [] }),
    // Statusline pollers (Claude + Codex)
    get_status_line: () => null,
    get_codex_status_line: () => null,
    // Agent detection
    detect_agent: () => false,
    detect_agents: () => ({ claude: false, codex: false }),
    // Persisted state loaders
    load_persisted_state: () => persistedState,
    load_state: () => null,
    load_flights: () => [],
    load_agents: () => [],
    load_conversations: () => window.__PACKETBENCH_E2E_CONVERSATIONS__ || [],
    load_settings: () => ({}),
    save_agents_slice: () => null,
    save_flights_slice: () => null,
    save_issues_slice: (args) => {
      persistedState.issues = args.issues;
      return null;
    },
    save_memory_slice: () => null,
    // v0.8-H — memory inline surfaces: pin-toggle endpoint. Mock returns
    // null for "not found" so tests don't depend on a real backing store.
    toggle_pinned_pattern: () => null,
    save_persisted_state: () => null,
    save_servers_slice: () => null,
    save_settings_slice: () => null,
    save_ui_slice: () => null,
    save_workspaces_slice: () => null,
    // Durable localStorage mirror (see src/lib/storageMirror.ts). Playwright
    // clears localStorage between tests and there is no Rust data dir here, so
    // this is a per-page in-memory stand-in: the mirror boots, restores
    // nothing, and its debounced flushes land somewhere harmless instead of
    // rejecting as an unhandled invoke.
    load_webview_storage_mirror: () => ({}),
    save_webview_storage_mirror: () => null,
    // MCP config reads
    read_mcp_config: () => ({ servers: [] }),
    // Analytics / history / cost
    get_analytics: () => ({}),
    get_prompt_history: () => [],
    get_cost_summary: () => ({}),
    read_usage_analytics: () => JSON.stringify({
      totalCostUsd: 0,
      totalSessions: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      modelUsage: [],
      dailyCosts: [],
    }),
    get_sidecar_status: () => ({
      state: "not_started",
      restart_count: 0,
      last_error: null,
      pid: null,
      version: null,
      lifetime: {
        total_starts: 0,
        total_crashes: 0,
        last_crash_time: null,
        last_version: null,
        last_error: null,
        total_uptime_secs: 0,
      },
    }),
    get_provider_auth_status: (args) => {
      const provider = args && args.provider;
      return {
        status: provider === "ollama" ? "service_down" : "missing_key",
        hint: "E2E auth mock",
      };
    },
    list_ollama_models: () => [],
  };

  function invoke(cmd, args) {
    const handler = handlers[cmd];
    if (handler) {
      try {
        return Promise.resolve(handler(args));
      } catch (e) {
        return Promise.reject(e);
      }
    }
    return Promise.reject(new Error("[mock-tauri] unhandled invoke: " + cmd));
  }

  // Tauri v2 internals
  window.__TAURI_INTERNALS__ = {
    invoke,
    transformCallback: (cb) => {
      const id = Math.floor(Math.random() * 1e9);
      // @ts-ignore
      window["_" + id] = cb;
      return id;
    },
    unregisterCallback: (id) => {
      // @ts-ignore
      delete window["_" + id];
    },
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    plugins: {},
  };

  // Event API no-ops
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => {},
  };
})();
`;
