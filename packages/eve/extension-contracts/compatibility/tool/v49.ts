import { defineWorkflowTool } from "#public/tools/index.js";

export default defineWorkflowTool({
  description: "Inspect available agents.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute(_input, ctx) {
    return ctx.agents;
  },
});
