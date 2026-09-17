import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  ...e2eAgentConfig(),
  model: mockModel({
    modelId: "agent-router-parent",
    respond(request) {
      if (request.tools.some((tool) => tool.name === "worker")) {
        throw new Error("The hidden worker was exposed to the parent model.");
      }
      const result = request.toolResults.find((entry) => entry.name === "agent-router");
      return result === undefined
        ? {
            toolCalls: [
              {
                name: "agent-router",
                input: { message: "Return the agent-router marker." },
              },
            ],
          }
        : JSON.stringify(result.output);
    },
  }),
  modelContextWindowTokens: 1_000_000,
  tool: false,
});
