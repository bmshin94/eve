import { defineEval } from "eve/evals";

export default defineEval({
  description: "agentRouter invokes a sole hidden subagent through the provided workflow tool.",
  async test(t) {
    const turn = await t.send("Route this task.");

    turn.expectOk();
    turn.messageIncludes("AGENT-ROUTER-WORKER-OK");
    turn.calledTool("agent-router", { count: 1 });
    turn.calledSubagent("worker", { count: 1, status: "pending" });
    t.succeeded();
    t.noFailedActions();
  },
});
