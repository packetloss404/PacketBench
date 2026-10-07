/** Named API services. Credentials never live in this frontend registry. */
export const NAMED_PROVIDERS = [
  {
    id: "sugar",
    name: "Sugar",
    baseUrl: "https://usesugar.dev/api/v1",
    description: "Sugar gateway API key. For local development, use http://localhost:3211/api/v1.",
  },
  {
    id: "cline-pass",
    name: "ClinePass",
    baseUrl: "https://api.cline.bot/api/v1",
    description: "Cline API key with an active Pass plan. Lists the Pass catalog only.",
  },
  {
    id: "opencode-go",
    name: "OpenCode Go",
    baseUrl: "https://opencode.ai/zen/go/v1",
    description: "OpenCode Go subscription API key.",
  },
  {
    id: "ollama-cloud",
    name: "Ollama Cloud",
    baseUrl: "https://ollama.com/v1",
    description:
      "Ollama account API key. Connects directly to the cloud; no local daemon required.",
  },
  {
    id: "google",
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    description: "Google AI Studio API key. Include /v1beta/openai in the endpoint URL.",
  },
  {
    id: "xai",
    name: "xAI",
    baseUrl: "https://api.x.ai/v1",
    description: "xAI API key for Grok language models.",
  },
] as const;
