import { defineEval } from "eve/evals";

export default defineEval({
  tags: ["real-model"],
  description:
    "autoRouter sends the full hidden-agent description map to JEV and invokes its selected specialist.",
  async test(t) {
    const turn = await t.send("Use route-task to deploy the checkout service to production.");

    turn.expectOk();
    turn.messageIncludes("AUTO-ROUTER-OPERATOR");
    turn.calledTool("route-task", { count: 1 });
    turn.calledSubagent("operator", { count: 1, status: "pending" });
    turn.calledSubagent("researcher", { count: 0, status: "pending" });
    t.succeeded();
    t.noFailedActions();
  },
});
