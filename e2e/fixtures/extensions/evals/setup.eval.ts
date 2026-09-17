import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

export default defineEval({
  description: "Eval setup supplies the runner environment before the agent starts.",
  async test(t) {
    await t.require(process.env.EVE_E2E_SETUP_READY, equals("1"));
  },
});
