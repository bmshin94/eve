import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { mockModel, type MockModelRequest, type MockModelResponse } from "eve/evals";

function respond(request: MockModelRequest): MockModelResponse | string {
  const assignment = request.userMessages.find((message) =>
    message.startsWith("Bob prepares report "),
  );
  if (assignment !== undefined) {
    const marker = assignment.includes("report A") ? "A" : "B";
    if (!request.toolResults.some((result) => result.name === "release")) {
      return { toolCalls: [{ name: "release", input: { marker } }] };
    }
    return `REPORT:${marker}`;
  }
  const last =
    [...request.userMessages]
      .reverse()
      .find(
        (message) =>
          message.includes("Alice checks the status") ||
          message.startsWith("Background task task_"),
      ) ?? "";
  if (last.includes("Alice checks the status")) return "STATUS:AVAILABLE";
  const pending = ["A", "B"].filter(
    (marker) => !request.toolResults.some((result) => result.id === `report-${marker}`),
  );
  if (pending.length > 0) {
    return {
      toolCalls: pending.map((marker) => ({
        id: `report-${marker}`,
        name: "agent",
        input: {
          message: `Bob prepares report ${marker}. Ask Alice to release the report before returning its result.`,
        },
      })),
    };
  }
  const stateMessage = [...request.userMessages]
    .reverse()
    .find((message) => message.startsWith("[Task state]\n"));
  const state =
    stateMessage === undefined
      ? undefined
      : (JSON.parse(stateMessage.slice("[Task state]\n".length)) as {
          tasks: { output?: { type: string; data: unknown } }[];
        });
  const results =
    state?.tasks.flatMap((task) => (task.output?.type === "result" ? [task.output.data] : [])) ??
    [];
  return results.length > 0 ? JSON.stringify(results.sort()) : "REPORTS:STARTED";
}

const base = e2eAgentConfig({ mock: respond });
export default defineAgent({
  ...base,
  model: mockModel(respond),
  modelContextWindowTokens: base.modelContextWindowTokens ?? 1_000_000,
});
