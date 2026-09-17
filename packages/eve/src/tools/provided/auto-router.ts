import type { JsonValue } from "#shared/json.js";
import {
  AUTO_ROUTER_INPUT_SCHEMA,
  AUTO_ROUTER_TOOL_DESCRIPTION,
  executeAutoRouterTool,
  type AutoRouterInput,
} from "#execution/tools/auto-router.js";
import {
  defineWorkflowTool,
  type BlockingWorkflowToolDefinition,
} from "#tools/workflow-definition.js";

export type { AutoRouterInput };

export type AutoRouterTool = BlockingWorkflowToolDefinition<AutoRouterInput, JsonValue>;

/** Defines a workflow tool that uses JEV to route a task across all available declared subagents. */
export function autoRouter(): AutoRouterTool {
  return defineWorkflowTool({
    description: AUTO_ROUTER_TOOL_DESCRIPTION,
    execute: executeAutoRouterTool,
    inputSchema: AUTO_ROUTER_INPUT_SCHEMA,
  });
}
