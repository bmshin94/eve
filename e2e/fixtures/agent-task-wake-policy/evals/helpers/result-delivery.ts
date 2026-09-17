import { defineEval, type EveEvalTurn, type InputRequest } from "eve/evals";
import { equals } from "eve/evals/expect";

export function resultDeliveryEval({
  dependent = false,
  schedule,
}: { dependent?: boolean; schedule?: string } = {}) {
  return defineEval({
    description: dependent
      ? "Withhold Bob's first report until his second is ready, then deliver their comparison together."
      : "Deliver Bob's first report while his second report still awaits Alice's approval, then deliver the second without repeating the first.",
    timeoutMs: 120_000,
    async test(t) {
      if (schedule !== undefined && !t.target.capabilities.devRoutes)
        t.skip("Schedule dispatch requires dev routes.");
      const dispatched =
        schedule === undefined ? undefined : await t.target.dispatchSchedule(schedule);
      const scheduledTurn =
        dispatched === undefined ? undefined : t.target.watchTurn(dispatched.sessionIds[0]!);
      const started =
        scheduledTurn === undefined
          ? await t.send(
              dependent
                ? "Alice asks Bob to prepare reports A and B for a joint comparison. Share the comparison once both reports are available."
                : "Alice asks Bob to prepare two independent reports, A and B, and share each when it is ready.",
            )
          : await scheduledTurn.result();
      started.expectOk();
      started.calledSubagent("agent", { count: 2 });
      let streamIndex = (scheduledTurn?.session.state ?? t.state)!.streamIndex;
      const requests = new Map<string, InputRequest>();
      const turns: EveEvalTurn[] = [started];
      collectRequests(started);
      for (let attempt = 0; requests.size < 2 && attempt < 8; attempt += 1)
        collectRequests(await nextTurn());
      await t.require([...requests.keys()].sort(), equals(["A", "B"]));

      await release("A");
      if (dependent) {
        const first = await throughCompletion("REPORT:A");
        first.usedNoTools();
        await t.require(first.message, equals(undefined));
      } else {
        (await through('["REPORT:A"]')).usedNoTools();
      }
      await post({
        message: "Alice checks the status while Bob's second report awaits her approval.",
        turnPolicy: "queue",
      });
      (await through("STATUS:AVAILABLE")).usedNoTools();

      await release("B");
      const second = await through(dependent ? '["REPORT:A","REPORT:B"]' : '["REPORT:B"]');
      second.usedNoTools();
      const reports = turns
        .map((turn) => turn.message)
        .filter((message) => message?.startsWith('["REPORT:'));
      t.check(
        reports,
        equals(dependent ? ['["REPORT:A","REPORT:B"]'] : ['["REPORT:A"]', '["REPORT:B"]']),
      ).label(
        "independent results report immediately; dependent results remain available for the combined report",
      );
      for (const turn of turns) turn.noFailedActions();

      function collectRequests(turn: EveEvalTurn) {
        for (const request of turn.inputRequests) {
          const marker = request.action.input.marker;
          if (request.action.toolName === "release" && typeof marker === "string")
            requests.set(marker, request);
        }
      }

      async function release(marker: string) {
        await post({
          inputResponses: [{ requestId: requests.get(marker)!.requestId, optionId: "approve" }],
        });
      }

      async function post(body: unknown) {
        const response = await t.target.fetch(
          `/eve/v1/session/${encodeURIComponent(started.sessionId)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: t.signal,
          },
        );
        await t.require(response.status, equals(202));
        await response.body?.cancel();
      }

      async function nextTurn() {
        const live = t.target.watchTurn(started.sessionId, { startIndex: streamIndex });
        const turn = (await live.result()).expectOk();
        streamIndex = live.session.state!.streamIndex;
        turns.push(turn);
        return turn;
      }

      async function throughCompletion(marker: string) {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const turn = await nextTurn();
          if (
            turn.events.some(
              (event) =>
                event.type === "message.received" &&
                JSON.stringify(event.data.message).includes(marker),
            )
          )
            return turn;
        }
        throw new Error(`The parent did not receive ${marker}.`);
      }

      async function through(message: string) {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const turn = await nextTurn();
          if (turn.message === message) return turn;
          if (turn.message?.startsWith('["REPORT:'))
            throw new Error(`Unexpected report: ${turn.message}`);
        }
        throw new Error(`The parent did not produce ${message}.`);
      }
    },
  });
}
