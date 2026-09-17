import { z } from "#compiled/zod/index.js";
import type { JsonObject } from "#shared/json.js";

export { executeAutoRouterTool } from "#execution/tools/auto-router-workflow.js";

export const AUTO_ROUTER_TOOL_DESCRIPTION =
  "Route a task to the best available subagent based on each subagent's declared description.";

export interface AutoRouterInput {
  readonly message: string;
  readonly outputSchema?: JsonObject;
}

export const AUTO_ROUTER_INPUT_SCHEMA: z.ZodType<AutoRouterInput> = z.strictObject({
  message: z.string().min(1).describe("The complete task to send to the selected agent."),
  outputSchema: z
    .record(z.string(), z.json())
    .describe("Optional JSON Schema the selected agent's output must match.")
    .optional(),
});
