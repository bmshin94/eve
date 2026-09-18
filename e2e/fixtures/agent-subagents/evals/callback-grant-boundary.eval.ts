import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

const origin = "https://callback.invalid";
const callback = {
  callId: "callback-grant-boundary",
  subagentName: "worker",
  token: "opaque",
  url: `${origin}/eve/v1/callback/opaque`,
};

export default defineEval({
  tags: ["callback-auth"],
  description:
    "HTTP create and continuation requests cannot supply internal callback grants through router-marked or observer requests.",
  async test(t) {
    // Keep the driver's real outbound auth on the router-marked request.
    const callers: Record<string, string>[] = [
      { "x-eve-e2e-router": "remote-loopback" },
      { authorization: "Bearer e2e-workspace-label-observer" },
    ];
    for (const headers of callers) {
      for (const path of ["/eve/v1/session", "/eve/v1/session/callback-grant-boundary-missing"]) {
        for (const body of [
          {
            message: "Alice asks Bob to summarize the weekly report.",
            callback: { ...callback, __eveCallbackOrigin: origin },
          },
          {
            message: "Alice asks Bob to summarize the weekly report.",
            callback,
            activityObserver: {
              sink: {
                url: `${origin}/eve/v1/activity/abcdefghijklmnopqrstuvwxyz123456`,
                version: 1,
                __eveCallbackOrigin: origin,
              },
              workIdentity: {
                id: "work",
                kind: "remote-agent",
                name: callback.subagentName,
                callId: callback.callId,
                rootSessionId: "root",
                rootTurnId: "turn",
              },
            },
          },
        ]) {
          const response = await t.target.fetch(path, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          t.check(response.status, equals(400));
          t.check(response.headers.get("x-eve-session-id"), equals(null));
        }
      }
    }
  },
});
