import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import {
  SessionDynamicSubagentSelectionsKey,
  TurnDynamicSubagentSelectionsKey,
} from "#context/keys.js";
import { resolveWorkflowAgentMetadata } from "#execution/tools/subagent/metadata.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";

describe("resolveWorkflowAgentMetadata", () => {
  it("includes hidden static subagents without adding self-delegation", () => {
    const ctx = context({
      nodeId: undefined,
      subagentsByName: new Map([
        [
          "researcher",
          {
            definition: {
              description: "Investigate difficult questions.",
              kind: "subagent",
              tool: false,
            },
          },
        ],
      ]),
    });

    expect(resolveWorkflowAgentMetadata(ctx)).toEqual({
      researcher: { description: "Investigate difficult questions." },
    });
  });

  it("uses effective dynamic descriptions with turn precedence", () => {
    const ctx = context({ nodeId: "subagents/coordinator", subagentsByName: new Map() });
    const prepared = { name: "reviewer" };
    ctx.set(SessionDynamicSubagentSelectionsKey, {
      reviewer: {
        agentConfig: { description: "Review generally." },
        kind: "subagent",
        prepared,
      } as never,
    });
    ctx.set(TurnDynamicSubagentSelectionsKey, {
      reviewer: {
        kind: "remote",
        prepared,
        remoteAgent: { description: "Review this tenant." },
      } as never,
    });

    expect(resolveWorkflowAgentMetadata(ctx)).toEqual({
      reviewer: { description: "Review this tenant." },
    });
  });
});

function context(input: {
  readonly nodeId: string | undefined;
  readonly subagentsByName: ReadonlyMap<string, unknown>;
}): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(BundleKey, {
    nodeId: input.nodeId,
    subagentRegistry: { subagentsByName: input.subagentsByName },
  } as never);
  return ctx;
}
