// Browser-only transport fixture. Production pane, event listeners and xterm
// stay real; this never starts a host process or touches user app state.
const callbacks = new Map<number, (event: unknown) => void>();
const listeners = new Map<number, { event: string; handler: number }>();
let serial = 0;
export const bridge = {
  launches: [] as string[],
  kills: [] as string[],
  resizes: [] as unknown[],
  writes: [] as unknown[],
  unexpected: [] as string[],
  emit(event: string, payload: unknown) {
    for (const [id, listener] of listeners) {
      if (listener.event === event) callbacks.get(listener.handler)?.({ event, id, payload });
    }
  },
  ready(event: string) {
    return [...listeners.values()].some((listener) => listener.event === event);
  },
};

const internals = {
  async invoke(command: string, args: Record<string, unknown> = {}) {
    switch (command) {
      case "plugin:event|listen": {
        const id = ++serial;
        listeners.set(id, { event: String(args.event), handler: Number(args.handler) });
        return id;
      }
      case "plugin:event|unlisten":
        listeners.delete(Number(args.eventId));
        return null;
      case "create_pty_session": {
        const id = `acceptance-session-${bridge.launches.length}`;
        bridge.launches.push(id);
        return id;
      }
      case "kill_pty":
        bridge.kills.push(String(args.sessionId));
        return null;
      case "resize_pty":
        bridge.resizes.push(args);
        return null;
      case "write_pty":
        bridge.writes.push(args);
        return null;
      case "list_pty_sessions":
        return bridge.launches.map((id) => ({
          id,
          alive: !bridge.kills.includes(id),
          project_path: "/acceptance",
          pid: null,
        }));
      case "read_pty_transcript":
        return { session_id: args.sessionId, data: "", sequence: 0, truncated: false };
      case "get_git_branch":
        return "acceptance";
      case "get_git_status":
        return { clean: true, staged: [], unstaged: [], untracked: [] };
      case "get_status_line":
      case "get_codex_status_line":
        return null;
      case "save_workspaces_slice":
      case "save_webview_storage_mirror":
      case "save_agents_slice":
      case "save_memory_slice":
      case "save_settings_slice":
      case "save_ui_slice":
        return null;
      case "load_webview_storage_mirror":
        return {};
      default:
        bridge.unexpected.push(command);
        throw new Error(`Unimplemented acceptance transport: ${command}`);
    }
  },
  transformCallback(callback: (event: unknown) => void) {
    const id = ++serial;
    callbacks.set(id, callback);
    return id;
  },
  unregisterCallback(id: number) {
    callbacks.delete(id);
  },
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  plugins: {},
};
Object.assign(window, {
  __TAURI_INTERNALS__: internals,
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (id: number) => listeners.delete(id) },
});
