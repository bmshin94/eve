import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  description: "Handle every delegated task in this fixture.",
  model: mockModel({ modelId: "agent-router-worker", respond: "AGENT-ROUTER-WORKER-OK" }),
  modelContextWindowTokens: 1_000_000,
  tool: false,
});
