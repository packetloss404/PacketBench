import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ProviderPicker } from "@/components/agents/composer/ProviderPicker";
import { Modal } from "@/components/ui/Modal";
import { API_PROVIDERS } from "@/lib/api-models";
import type { AgentCli } from "@/stores/agentTaskStore";
import "@/index.css";

export function Harness() {
  const [agent, setAgent] = useState<AgentCli>("api-claude");
  const [refreshes, setRefreshes] = useState(0);
  const authStatus = Object.fromEntries(
    API_PROVIDERS.map((provider) => [
      provider.agentCli,
      { status: "ready" as const, hint: refreshes ? "API ready" : "" },
    ]),
  );
  return (
    <Modal
      title="Flight brief picker acceptance"
      onClose={() => {}}
      footer={<button type="button">Run Flight</button>}
    >
      <div className="p-4">
        <div style={{ height: 1100 }}>Scroll to the reviewer picker.</div>
        <div data-testid="provider-anchor">
          <ProviderPicker
            selectedAgent={agent}
            onAgentChange={setAgent}
            onModelChange={() => {}}
            authStatus={authStatus}
            refreshAuthStatuses={() => setRefreshes((count) => count + 1)}
          />
        </div>
        <p role="status">Selected {agent}</p>
      </div>
    </Modal>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
