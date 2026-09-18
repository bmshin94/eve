import { afterEach, expect, it, vi } from "vitest";
import { createSession } from "#channel/session.js";
import type { RouteHandlerArgs } from "#channel/routes.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import { workflowEntry } from "#execution/session/entry.js";
import { createWorkflowRuntime, waitForCommandHookOwner } from "#execution/workflow-runtime.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { filterEventsByType } from "#internal/testing/events.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import { attachRouteSessionCreator } from "#internal/nitro/routes/channel-route-context.js";
import { start } from "#internal/workflow/runtime.js";
import { eveChannel } from "#public/channels/eve.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";
import { toInputSchema } from "#tools/schema.js";
import { VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER } from "#client/types.js";

const origin = "https://parent.example.com";
const callback = {
  callId: "original-call",
  subagentName: "worker",
  token: "opaque",
  url: `${origin}/eve/v1/callback/opaque`,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

it.each(["untrusted", "absent"] as const)(
  "preserves the active HITL callback grant but does not reuse it for a later %s callback",
  async (nextCallback) => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_URL", "child.example.com");
    vi.stubEnv("VERCEL_BRANCH_URL", undefined);
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", undefined);
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "callback-test");
    vi.stubEnv("VERCEL_OIDC_TOKEN", "child-initial-token");
    vi.stubGlobal(Symbol.for("@vercel/request-context"), undefined);
    const execute = vi.fn(async () => "approved");
    const tool: ResolvedToolDefinition = {
      name: "approval_gate",
      logicalPath: "tools/approval_gate.ts",
      sourceId: "tools/approval_gate.ts",
      sourceKind: "module",
      owner: { kind: "application" },
      description: "Requires approval before returning.",
      inputSchema: toInputSchema({ type: "object", properties: {}, additionalProperties: false }),
      approval: () => "user-approval",
      execute,
    };
    const app = await createTestRuntime({
      agent: { name: "callback-hitl-binding" },
      tools: [tool],
    });
    const definition = app.manifest.tools.find((entry) => entry.name === tool.name)!;
    app.moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]!.modules[definition.sourceId] = {
      default: { execute, approval: tool.approval },
    };
    const posts: Array<{ url: string; body: Record<string, unknown>; token: string | null }> = [];
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(origin) || url.startsWith("https://replacement.example.com")) {
        posts.push({
          url,
          body: JSON.parse(String(init?.body)),
          token: new Headers(init?.headers).get(VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER),
        });
        return new Response(null, { status: 202 });
      }
      return originalFetch(input, init);
    }) as typeof fetch);

    await app.run(async () => {
      let trusted = true;
      const policy = vi.fn(() => trusted);
      const channel = eveChannel({
        auth: () => ({
          authenticator: "fixture",
          principalType: "service",
          principalId: "parent",
          attributes: {},
        }),
        trustedForwarders: policy,
      });
      const runtime = createWorkflowRuntime({
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      });
      let run: Awaited<ReturnType<typeof start>> | undefined;
      async function request(body: object, sessionId?: string): Promise<Response> {
        const path = sessionId === undefined ? "/eve/v1/session" : "/eve/v1/session/:sessionId";
        const route = channel.routes.find(
          (entry) => entry.method === "POST" && entry.path === path,
        )!;
        const args = attachRouteSessionCreator(
          {
            ...mockChannelContext(vi.fn()),
            params: sessionId === undefined ? {} : { sessionId },
            attachSession: (id) => createSession(id, runtime),
            to: vi.fn() as never,
            waitUntil: () => undefined,
            requestIp: "127.0.0.1",
          } satisfies RouteHandlerArgs,
          async (input) => {
            run = await start(workflowEntry, [
              {
                kind: "initial",
                ownerDeploymentId: "callback-test",
                sessionTimeoutMs: false,
                input: input.input,
                serializedContext: {
                  "eve.bundle": { source: createBundledRuntimeCompiledArtifactsSource() },
                  "eve.channel": { kind: "http", state: {} },
                  "eve.mode": "conversation",
                  "eve.auth": input.auth,
                  "eve.capabilities": { requestInput: true },
                  "eve.sessionCallback": input.callback,
                },
              },
            ]);
            return { sessionId: run.runId, events: new ReadableStream() };
          },
        );
        const response = await route.handler(
          new Request(`https://child.example.com${path}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: "Bearer parent-incoming-token",
            },
            body: JSON.stringify(body),
          }),
          args,
        );
        if (!(response instanceof Response)) throw new Error("Expected HTTP response");
        return response;
      }
      let finished = false;
      let reader: ReadableStreamDefaultReader<MessageStreamEvent> | undefined;
      async function readUntil(type: MessageStreamEvent["type"]): Promise<MessageStreamEvent[]> {
        const events: MessageStreamEvent[] = [];
        return await withTimeout(
          (async () => {
            if (reader === undefined) throw new Error("Session stream was not opened");
            for (let count = 0; count < 200; count++) {
              const next = await reader.read();
              if (next.done) throw new Error(`Session stream closed before ${type}`);
              if (next.value.type === "session.failed") throw new Error("Session failed");
              events.push(next.value);
              if (next.value.type === type) return events;
            }
            throw new Error(`Session stream exceeded event limit before ${type}`);
          })(),
          type,
        );
      }
      try {
        // The built-in agent tool now launches background work and settles its
        // caller before that work requests input. Pause this callback's own turn.
        expect(
          (await request({ message: "Alice asks Bob to call approval_gate.", callback })).status,
        ).toBe(202);
        expect(policy).toHaveBeenCalledOnce();
        if (run === undefined) throw new Error("Session was not created");
        const active = run;
        reader = (await runtime.getEventStream(active.runId)).getReader();
        const prompt = await readUntil("session.waiting");
        expect(filterEventsByType(prompt, "input.requested")).toHaveLength(1);
        const inputRequest = filterEventsByType(prompt, "input.requested")[0]?.data.requests[0];
        if (inputRequest === undefined) throw new Error("Expected approval request");
        expect(inputRequest.kind).toBe("tool-approval");
        expect(execute).not.toHaveBeenCalled();
        expect(posts.some((post) => post.body.kind === "turn.completed")).toBe(false);
        // Inbox hooks are reusable: waitForHook filters out any hook that has
        // received a payload, which does not mean the current owner released it.
        await expect(
          withTimeout(
            waitForCommandHookOwner(sessionInboxHookToken(sessionCommandHookToken(active.runId))),
            "session inbox owner",
          ),
        ).resolves.toMatchObject({ runId: active.runId });
        trusted = false;
        policy.mockClear();
        const inputResponses = [{ requestId: inputRequest.requestId, optionId: "approve" }];
        const rejected = await request(
          {
            inputResponses,
            callback: {
              ...callback,
              callId: "replacement-call",
              url: "https://replacement.example.com/eve/v1/callback/opaque",
            },
          },
          active.runId,
        );
        expect(rejected.status).toBe(400);
        expect(await rejected.json()).toMatchObject({
          error: expect.stringContaining("Omit both"),
        });
        expect(policy).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();

        vi.stubEnv("VERCEL_OIDC_TOKEN", "child-current-token");
        expect((await request({ inputResponses }, active.runId)).status).toBe(202);
        expect(policy).not.toHaveBeenCalled();
        const completed = await readUntil("session.waiting");
        expect(filterEventsByType(completed, "session.failed")).toHaveLength(0);
        expect(execute).toHaveBeenCalledOnce();
        await expect
          .poll(() => posts.find((post) => post.body.kind === "turn.completed"))
          .toMatchObject({
            url: callback.url,
            token: "child-current-token",
            body: { callId: "original-call", subagentName: "worker" },
          });
        expect(posts.every((post) => post.url === callback.url)).toBe(true);

        const acceptedPosts = posts.length;
        const followUpCallback =
          nextCallback === "untrusted" ? { ...callback, callId: "next-call" } : undefined;
        expect(
          (
            await request(
              {
                message: "Alice asks for a summary of the completed report.",
                callback: followUpCallback,
              },
              active.runId,
            )
          ).status,
        ).toBe(202);
        expect(policy).toHaveBeenCalledTimes(nextCallback === "untrusted" ? 1 : 0);
        const nextTurn = await readUntil("session.waiting");
        expect(filterEventsByType(nextTurn, "turn.completed")).toHaveLength(1);
        // A streamed park precedes caller notification. Finish the owner before
        // asserting absence so a late callback cannot make this a false pass.
        await expect(
          runtime.dispatchSession({
            sessionId: active.runId,
            command: { kind: "reset" },
          }),
        ).resolves.toEqual({ status: "reset", previousSessionId: active.runId });
        await withTimeout(active.returnValue, "session completion");
        finished = true;
        if (nextCallback === "untrusted") {
          expect(posts.slice(acceptedPosts)).toMatchObject([
            {
              url: callback.url,
              token: null,
              body: { kind: "turn.completed", callId: "next-call", subagentName: "worker" },
            },
          ]);
        } else {
          expect(posts).toHaveLength(acceptedPosts);
        }
        expect(posts.every((post) => post.url === callback.url)).toBe(true);
        expect(execute).toHaveBeenCalledOnce();
      } finally {
        try {
          await withTimeout(reader?.cancel() ?? Promise.resolve(), "stream cleanup");
        } finally {
          reader?.releaseLock();
          if (run !== undefined && !finished) await withTimeout(run.cancel(), "session cleanup");
        }
      }
    });
  },
  30_000,
);
