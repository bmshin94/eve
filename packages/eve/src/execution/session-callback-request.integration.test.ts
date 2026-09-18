import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionAuthContext, Runtime, ActivityObserverConfig } from "#channel/types.js";
import { createSession } from "#channel/session.js";
import { parseSessionCallback } from "#channel/session-callback.js";
import { VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER } from "#client/types.js";
import { ActivityObserverKey, SessionCallbackKey } from "#context/keys.js";
import { serializeContext } from "#context/serialize.js";
import { buildRunContext } from "#execution/runtime-context.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import {
  bindTurnCallerContextStep,
  notifyCancelledTaskCallerStep,
  notifyTurnCallerStep,
  resolveInitialTurnCallerStep,
} from "#subagents/parent-notification.js";
import { fireSessionCallbackStep, fireTaskEventCallbackStep } from "#subagents/callback-step.js";
import { submitActivity } from "#execution/submit-activity.js";
import { postSessionCallbackRequest } from "#execution/session-callback-request.js";
import { encodeSessionInboxCommand } from "#execution/session-inbox/encode.js";
import { decodeSessionInboxPayload } from "#execution/session-inbox/protocol.js";
import { CALLBACK_ORIGIN_KEY, readCallbackOrigin } from "#internal/callback-auth.js";
import {
  attachRouteSessionCreator,
  type RouteSessionCreator,
} from "#internal/nitro/routes/channel-route-context.js";
import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import { eveChannel, type EveChannelInput } from "#public/channels/eve.js";
import { none } from "#public/channels/auth.js";

const origin = "https://parent.example.com";
const callback = {
  callId: "call",
  subagentName: "worker",
  taskId: "task",
  token: "opaque",
  url: `${origin}/eve/v1/callback/opaque?x-vercel-protection-bypass=existing`,
};
const activityObserver: ActivityObserverConfig = {
  sink: { version: 1, url: `${origin}/eve/v1/activity/abcdefghijklmnopqrstuvwxyz123456` },
  workIdentity: {
    id: "work",
    kind: "remote-agent",
    name: "worker",
    callId: "call",
    rootSessionId: "parent",
    rootTurnId: "parent-turn",
  },
};
const sender: SessionAuthContext = {
  attributes: {},
  authenticator: "verified-test-transport",
  principalId: "parent-deployment",
  principalType: "service",
  subject: "parent-subject",
};
const user: SessionAuthContext = {
  attributes: { [CALLBACK_ORIGIN_KEY]: origin },
  authenticator: "user-auth",
  principalId: "end-user",
  principalType: "user",
};
const fetchMock = vi.fn(
  async (_url: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 202 }),
);
const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const tokens = () =>
  fetchMock.mock.calls.map(([, init]) =>
    new Headers(init?.headers).get(VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER),
  );

function harness(
  policy?: EveChannelInput["trustedForwarders"],
  onMessage?: EveChannelInput["onMessage"],
  auth: EveChannelInput["auth"] = async (request) =>
    request.headers.get("authorization") === "Bearer parent-incoming-token" ? sender : null,
) {
  const channel = eveChannel({
    auth,
    trustedForwarders: policy,
    onMessage,
  });
  let context: Record<string, unknown> = {};
  const dispatchSession = vi.fn(async (input: Parameters<Runtime["dispatchSession"]>[0]) => {
    const decoded = decodeSessionInboxPayload(
      roundTrip(encodeSessionInboxCommand(input.command, 8)),
    );
    // This fixture simulates only new message turns, not active-turn HITL routing.
    if (
      decoded.kind === "deliver" &&
      decoded.payloads.some((payload) => payload.message !== undefined)
    ) {
      context = await bindTurnCallerContextStep({
        caller: decoded.caller,
        serializedContext: context,
      });
    }
    return { sessionId: "child", status: "accepted" } as never;
  });
  const create = vi.fn(async (input: Parameters<RouteSessionCreator>[0]) => {
    const ctx = buildRunContext({
      bundle: {} as never,
      run: { ...input, adapter: { kind: "http" } },
    });
    // Exercise real context serialization without requiring an unrelated compiled bundle.
    ctx.delete(BundleKey);
    ctx.delete(ChannelKey);
    context = roundTrip(serializeContext(ctx));
    return { sessionId: "child", events: new ReadableStream() };
  });
  async function request(
    body: object,
    continuation = false,
    authorization = "Bearer parent-incoming-token",
  ) {
    const path = continuation ? "/eve/v1/session/:sessionId" : "/eve/v1/session";
    const route = channel.routes.find((route) => route.method === "POST" && route.path === path)!;
    const args = attachRouteSessionCreator(
      {
        ...mockChannelContext(vi.fn()),
        attachSession: () =>
          createSession("child", {
            createSession: vi.fn(),
            dispatchContinuation: vi.fn(),
            dispatchSession,
            resolveContinuation: vi.fn(),
            getEventStream: vi.fn(),
            getStreamTailIndex: vi.fn(),
          }),
        to: vi.fn() as never,
        params: continuation ? { sessionId: "child" } : {},
        requestIp: "127.0.0.1",
        waitUntil: () => undefined,
      },
      create,
    );
    const response = await route.handler(
      new Request(`https://child.example.com${path}`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          authorization,
          "content-type": "application/json",
          "x-eve-callback-origin": origin,
        },
      }),
      args,
    );
    if (!(response instanceof Response)) throw new Error("Expected HTTP response");
    return response;
  }
  return { request, create, dispatchSession, context: () => context };
}

async function complete(context: Record<string, unknown>) {
  await fireSessionCallbackStep({
    serializedContext: roundTrip(context),
    status: "completed",
    output: "done",
  });
}

describe("server-granted callback authorization", () => {
  beforeEach(() => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_URL", "child.example.com");
    vi.stubEnv("VERCEL_BRANCH_URL", undefined);
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", undefined);
    vi.stubEnv("VERCEL_OIDC_TOKEN", "child-current-token");
    vi.stubGlobal(Symbol.for("@vercel/request-context"), undefined);
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("does not import the OIDC SDK or refresh local credentials", () => {
    const source = readFileSync(new URL("./session-callback-request.ts", import.meta.url), "utf8");
    expect(source).not.toContain("@vercel/oidc");
    expect(source).not.toContain("getVercelOidcToken");
  });

  it.each([undefined, () => false])(
    "gives no own credentials without an accepting policy: %s",
    async (policy) => {
      const app = harness(policy);
      expect(
        (
          await app.request({
            message: "work",
            callback,
            [CALLBACK_ORIGIN_KEY]: origin,
            auth: { trusted: true },
          })
        ).status,
      ).toBe(202);
      expect(readCallbackOrigin(app.context()[SessionCallbackKey.name])).toBeUndefined();
      await complete(app.context());
      expect(tokens()).toEqual([null]);
    },
  );

  it.each(["create", "continue"])("rejects a forged callback grant on %s", async (kind) => {
    const policy = vi.fn(() => true);
    const app = harness(policy);
    const response = await app.request(
      { message: "work", callback: { ...callback, [CALLBACK_ORIGIN_KEY]: origin } },
      kind === "continue",
    );
    expect(response.status).toBe(400);
    expect(app.create).not.toHaveBeenCalled();
    expect(app.dispatchSession).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(parseSessionCallback({ ...callback, [CALLBACK_ORIGIN_KEY]: origin }).ok).toBe(false);
  });

  it("rejects a forged activity-sink grant and does not trust body auth or headers", async () => {
    const policy = vi.fn(() => true);
    const app = harness(policy);
    expect(
      (
        await app.request({
          message: "work",
          callback,
          activityObserver: {
            ...activityObserver,
            sink: { ...activityObserver.sink, [CALLBACK_ORIGIN_KEY]: origin },
          },
        })
      ).status,
    ).toBe(400);
    policy.mockClear();
    expect(
      (
        await app.request(
          { message: "work", callback, auth: sender, [CALLBACK_ORIGIN_KEY]: origin },
          false,
          "Bearer forged",
        )
      ).status,
    ).toBe(401);
    expect(policy).not.toHaveBeenCalled();
    expect(app.create).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "grants on verified transport identity, with forwarded principal=%s",
    async (forwardPrincipal) => {
      const policy = vi.fn((principal: SessionAuthContext) => principal === sender);
      const app = harness(policy, () => ({ auth: user }));
      const body = {
        message: "work",
        callback,
        activityObserver,
        forwardedPrincipal: forwardPrincipal ? { current: user } : undefined,
      };
      expect((await app.request(body)).status).toBe(202);
      expect(policy).toHaveBeenCalledExactlyOnceWith(sender);
      expect(readCallbackOrigin(app.context()[SessionCallbackKey.name])).toBe(origin);
      expect(JSON.stringify(app.context())).not.toContain("parent-incoming-token");
      expect(JSON.stringify(app.context())).not.toContain("child-current-token");
      await complete(app.context());
      expect(tokens()).toEqual(["child-current-token"]);
      expect(fetchMock.mock.calls[0]?.[0]).toBe(callback.url);
    },
  );

  it.each([false, true])(
    "never grants anonymous transport credentials, even with forwarded principal=%s",
    async (forwardPrincipal) => {
      const policy = vi.fn(() => true);
      const app = harness(policy, () => ({ auth: user }), none());
      const body = {
        message: "work",
        callback,
        forwardedPrincipal: forwardPrincipal ? { current: user } : undefined,
      };
      expect((await app.request(body, false, "")).status).toBe(202);
      expect((await app.request(body, true, "")).status).toBe(202);
      expect(policy).toHaveBeenCalledTimes(2);
      expect(policy).toHaveBeenLastCalledWith(
        expect.objectContaining({ principalType: "anonymous" }),
      );
      expect(readCallbackOrigin(app.context()[SessionCallbackKey.name])).toBeUndefined();
      await complete(app.context());
      expect(tokens()).toEqual([null]);
    },
  );

  it("fails closed when a callback-only policy throws", async () => {
    const app = harness(() => {
      throw new Error("policy unavailable");
    });
    expect((await app.request({ message: "work", callback })).status).toBe(500);
    expect(app.create).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the previous grant when a refused forwarded-principal continuation is rejected", async () => {
    let trusted = true;
    const app = harness(() => trusted);
    await app.request({ message: "work", callback });
    const before = roundTrip(app.context());
    trusted = false;
    expect(
      (
        await app.request(
          { message: "next", callback, forwardedPrincipal: { current: user } },
          true,
        )
      ).status,
    ).toBe(403);
    expect(app.context()).toEqual(before);
    expect(app.dispatchSession).not.toHaveBeenCalled();
  });

  it("uses fresh child tokens for every callback path after durable serialization", async () => {
    const app = harness(() => true);
    await app.request({ message: "work", callback, activityObserver });
    let read = 0;
    vi.stubGlobal(Symbol.for("@vercel/request-context"), {
      get: () => ({
        headers: {
          "x-vercel-oidc-token": `child-step-token-${++read}`,
          authorization: "Bearer parent-incoming-token",
          [VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER]: "parent-protection-token",
        },
      }),
    });
    const context = app.context();
    const stored = context[SessionCallbackKey.name];
    const caller = roundTrip(await resolveInitialTurnCallerStep({ serializedContext: context }));
    await complete(context);
    await fireSessionCallbackStep({
      serializedContext: context,
      status: "failed",
      error: "failure",
    });

    await fireTaskEventCallbackStep({
      callback: stored,
      childContinuationToken: "child-capability",
      childSessionId: "child",
      event: {
        type: "input.requested",
        data: { requests: [], sequence: 1, stepIndex: 1, turnId: "turn" },
      },
    });
    await fireTaskEventCallbackStep({
      callback: stored,
      childContinuationToken: "child-capability",
      childSessionId: "child",
      event: { type: "authorization.completed", data: { connection: "test" } } as never,
    });

    await notifyTurnCallerStep({
      caller,
      sessionId: "child",
      lifecycle: "parked",
      settled: { output: "done" },
    });
    await notifyTurnCallerStep({
      caller,
      sessionId: "child",
      lifecycle: "terminal",
      settled: { output: "failed", isError: true },
    });
    await notifyCancelledTaskCallerStep({ caller, sessionId: "child" });
    await submitActivity({
      sink: (context[ActivityObserverKey.name] as ActivityObserverConfig).sink,
      events: [
        {
          eventId: "event",
          kind: "work.started",
          startedAt: "now",
          work: activityObserver.workIdentity!,
        },
      ],
    });
    expect(tokens()).toEqual(Array.from({ length: 8 }, (_, i) => `child-step-token-${i + 1}`));
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(init?.redirect).toBe("error");
      expect(init?.body).not.toContain(CALLBACK_ORIGIN_KEY);
      expect(init?.body).not.toContain("token-1");
    }
  });

  it("re-evaluates continuations and retains only the old delegation's captured grant after revocation", async () => {
    let trusted = true;
    const policy = vi.fn(() => trusted);
    const app = harness(policy);
    await app.request({ message: "work", callback, activityObserver });
    const initialContext = roundTrip(app.context());
    const replacement = {
      ...callback,
      url: "https://replacement.example.com/eve/v1/callback/opaque",
    };
    await app.request({ message: "next", callback: replacement }, true);
    expect(readCallbackOrigin(app.context()[SessionCallbackKey.name])).toBe(
      "https://replacement.example.com",
    );
    expect(app.context()[ActivityObserverKey.name]).toBeUndefined();
    const acceptedContinuation = roundTrip(app.context());
    trusted = false;
    await app.request({ message: "after revocation", callback: replacement }, true);
    expect(policy).toHaveBeenCalledTimes(3);
    expect(readCallbackOrigin(app.context()[SessionCallbackKey.name])).toBeUndefined();
    await complete(initialContext);
    await complete(acceptedContinuation);
    await complete(app.context());
    expect(tokens()).toEqual(["child-current-token", "child-current-token", null]);
    await app.request({ message: "no delegation" }, true);
    expect(app.context()[SessionCallbackKey.name]).toBeUndefined();
  });

  it.each([{ callback }, { activityObserver }, { callback, activityObserver }])(
    "rejects bindings on input-only answers before policy or dispatch: %o",
    async (binding) => {
      const policy = vi.fn(() => true);
      const app = harness(policy);
      await app.request({ message: "work", callback });
      const captured = roundTrip(app.context());
      policy.mockImplementation(() => {
        throw new Error("must not evaluate replacement policy");
      });
      policy.mockClear();
      const response = await app.request(
        { inputResponses: [{ requestId: "request", optionId: "answer" }], ...binding },
        true,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining("Omit both"),
        ok: false,
      });
      expect(policy).not.toHaveBeenCalled();
      expect(app.dispatchSession).not.toHaveBeenCalled();
      expect(app.context()).toEqual(captured);
      await complete(captured);
      expect(tokens()).toEqual(["child-current-token"]);
    },
  );

  it.each([undefined, "", "   "])(
    "fails a granted send without child OIDC rather than substituting incoming tokens: %s",
    async (token) => {
      const app = harness(() => true);
      await app.request({ message: "work", callback });
      vi.stubEnv("VERCEL_OIDC_TOKEN", token);
      vi.stubGlobal(Symbol.for("@vercel/request-context"), {
        get: () => ({
          headers: {
            authorization: "Bearer parent",
            [VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER]: "parent-token",
          },
        }),
      });
      await expect(complete(app.context())).rejects.toThrow(
        "Enable OIDC for the sending Vercel deployment",
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("rejects downstream destination swaps even off Vercel instead of downgrading the grant", async () => {
    const app = harness(() => true);
    await app.request({ message: "work", callback });
    const context = app.context();
    const stored = context[SessionCallbackKey.name] as object;
    vi.stubEnv("VERCEL", undefined);
    await expect(
      complete({
        ...context,
        [SessionCallbackKey.name]: {
          ...stored,
          url: "https://different.example.com/eve/v1/callback/opaque",
        },
      }),
    ).rejects.toThrow("does not match the destination origin");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps non-Vercel sends credential-free and rejects redirects without retrying", async () => {
    vi.stubEnv("VERCEL", undefined);
    await postSessionCallbackRequest({ body: {}, url: callback.url, callbackOrigin: origin });
    expect(tokens()).toEqual([null]);
    vi.stubEnv("VERCEL", "1");
    fetchMock.mockRejectedValueOnce(new TypeError("unexpected redirect"));
    await expect(
      postSessionCallbackRequest({ body: {}, url: callback.url, callbackOrigin: origin }),
    ).rejects.toThrow("unexpected redirect");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]?.redirect).toBe("error");
  });
});
