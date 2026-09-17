import { e2eJudgeModel } from "@eve-e2e/config";
import { defineEvalConfig } from "eve/evals";

export default defineEvalConfig({
  judge: { model: e2eJudgeModel() },
  setup() {
    return { env: { EVE_E2E_SETUP_READY: "1" } };
  },
});
