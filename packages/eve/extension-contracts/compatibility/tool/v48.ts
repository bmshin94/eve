import { defineWorkflowTool } from "#public/tools/index.js";

export default defineWorkflowTool({
  description: "Delegate a review.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute(_input, ctx) {
    return ctx.agent("reviewer", { message: "Review the request." });
  },
});
