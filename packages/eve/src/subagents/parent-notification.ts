/**
 * Sends delegated task results to their parent and conversation results to
 * the caller of each turn.
 */

import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { deserializeContext } from "#context/serialize.js";
import {
  attachCallbackOrigin,
  parseStoredSessionCallback,
  readCallbackOrigin,
} from "#internal/callback-auth.js";
import { sessionCallbackToTurnCaller } from "#channel/session.js";
import type { ActivityObserverConfig, TurnCaller } from "#channel/types.js";
import type { RuntimeSubagentChildResult } from "#shared/action-types.js";
import { ActivityObserverKey, SessionCallbackKey } from "#context/keys.js";
import {
  isSubagentAdapterState,
  SUBAGENT_ADAPTER_KIND,
  type SubagentAdapterState,
} from "#subagents/adapter-state.js";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { SUBAGENT_EXECUTION_FAILED } from "#subagents/agent-handle-errors.js";
import { createLogger } from "#internal/logging.js";
import type { AgentTurnOutcome } from "#shared/agent-turn-outcome.js";
import { toErrorMessage } from "#shared/errors.js";
import { parseJsonValue } from "#shared/json.js";
import type { TokenUsage } from "#shared/token-usage.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { postSessionCallbackRequest } from "#execution/session-callback-request.js";
import { readTaskIdFromInboxToken } from "#tasks/task-inbox-token.js";

const log = createLogger("execution.delegated-parent-notification");

/**
 * Resumes the parent owner's hook with a delegated subagent result.
 * No-op for root sessions.
 *
 * `usage` — the completed child's session-total token spend — is
 * attached to success results so the caller can attribute the
 * subagent's tokens. Error results never carry usage.
 */
export async function notifyDelegatedParentStep(input: {
  readonly result: RuntimeSubagentChildResult | undefined;
  readonly serializedContext: Record<string, unknown>;
  readonly usage?: TokenUsage;
}): Promise<void> {
  "use step";

  if (input.result === undefined) {
    return;
  }

  const ctx = await deserializeContext(input.serializedContext);
  const adapter = ctx.get(ChannelKey);

  if (adapter?.kind !== SUBAGENT_ADAPTER_KIND) {
    return;
  }

  const parentContinuationToken = String(adapter.state?.parentContinuationToken ?? "");
  if (parentContinuationToken === "") {
    return;
  }

  // A task child reports its session totals exactly once, so those totals
  // are the turn's usage delta; the terminal envelope carries them so the
  // parent folds spend from the outcome alone.
  const result =
    input.usage === undefined
      ? input.result
      : {
          ...input.result,
          outcome: { ...input.result.outcome, usageDelta: input.usage },
          usage: input.usage,
        };

  await resumeHook(parentContinuationToken, {
    kind: "runtime-action-result",
    results: [result],
  });
}

/** Settled turn payload forwarded from the owner to the caller. */
export interface SettledTurnNotification {
  readonly output: unknown;
  readonly isError?: boolean;
  /** Usage this turn added; omitted (zero) on crash and expiry paths. */
  readonly usage?: TokenUsage;
}

const ZERO_TOKEN_USAGE: TokenUsage = {
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
};

/**
 * Sends a settled conversation turn to the caller that started it.
 *
 * `lifecycle` is the child engine's explicit verdict — `parked` when the
 * child session survived the turn and can accept another delivery,
 * `terminal` when it ended with this turn. It is carried on the result as
 * an {@link AgentTurnOutcome} so the caller never infers lifecycle from
 * success or error codes.
 */
export async function notifyTurnCallerStep(input: {
  readonly caller: TurnCaller | undefined;
  readonly lifecycle: AgentTurnOutcome["kind"];
  readonly sessionId: string;
  readonly settled: SettledTurnNotification;
}): Promise<void> {
  "use step";

  if (input.caller === undefined) {
    return;
  }

  const result = createSettledTurnResult({
    caller: input.caller,
    lifecycle: input.lifecycle,
    sessionId: input.sessionId,
    settled: input.settled,
  });

  if (input.caller.replyTo.kind === "callback") {
    await postSettledTurnCallback({
      result,
      sessionId: input.sessionId,
      callbackOrigin: readCallbackOrigin(input.caller.replyTo),
      url: input.caller.replyTo.url,
    });
    return;
  }

  await resumeSettledTurnHook(input.caller.replyTo.token, result);
}

/** Settles a workflow-owned caller after the child turn is cooperatively cancelled. */
export async function notifyCancelledTaskCallerStep(input: {
  readonly caller: TurnCaller | undefined;
  readonly sessionId: string;
  readonly usage?: TokenUsage;
}): Promise<void> {
  "use step";

  if (input.caller === undefined) return;
  const usageDelta = input.usage ?? ZERO_TOKEN_USAGE;
  const error = {
    code: SUBAGENT_EXECUTION_FAILED,
    message: "The agent invocation was cancelled.",
  };
  const base: RuntimeSubagentChildResult = {
    callId: input.caller.callId,
    isError: true,
    kind: "subagent-result",
    origin: "child",
    outcome: {
      kind: "parked",
      result: { kind: "cancelled" },
      usageDelta,
    },
    output: error,
    subagentName: input.caller.subagentName,
  };
  const result = input.usage === undefined ? base : { ...base, usage: input.usage };
  if (input.caller.replyTo.kind === "callback") {
    await postSettledTurnCallback({
      result,
      sessionId: input.sessionId,
      callbackOrigin: readCallbackOrigin(input.caller.replyTo),
      url: input.caller.replyTo.url,
    });
    return;
  }
  await resumeSettledTurnHook(input.caller.replyTo.token, result);
}

function createSettledTurnResult(input: {
  readonly caller: TurnCaller;
  readonly lifecycle: AgentTurnOutcome["kind"];
  readonly sessionId: string;
  readonly settled: SettledTurnNotification;
}): RuntimeSubagentChildResult {
  const usageDelta = input.settled.usage ?? ZERO_TOKEN_USAGE;

  if (input.settled.isError === true) {
    const error = {
      code: SUBAGENT_EXECUTION_FAILED,
      message: toErrorMessage(input.settled.output),
    };
    return {
      callId: input.caller.callId,
      isError: true,
      kind: "subagent-result",
      origin: "child",
      outcome: {
        kind: input.lifecycle,
        result: { error, kind: "failed" },
        usageDelta,
      },
      output: error,
      subagentName: input.caller.subagentName,
    };
  }

  const output = parseJsonValue(input.settled.output);
  const result: RuntimeSubagentChildResult = {
    callId: input.caller.callId,
    kind: "subagent-result",
    origin: "child",
    outcome: {
      kind: input.lifecycle,
      result: { kind: "succeeded", output },
      usageDelta,
    },
    output,
    subagentName: input.caller.subagentName,
  };
  // Legacy per-result usage projection (usage spans); the parent folds
  // `outcome.usageDelta`, never this field, when an outcome is present.
  return input.settled.usage === undefined ? result : { ...result, usage: input.settled.usage };
}

/** Resolves the caller that created a delegated conversation session. */
export async function resolveInitialTurnCallerStep(input: {
  readonly serializedContext: Record<string, unknown>;
}): Promise<TurnCaller | undefined> {
  "use step";

  const callbackValue = input.serializedContext[SessionCallbackKey.name];
  if (callbackValue !== undefined) {
    const callback = parseStoredSessionCallback(callbackValue);
    return sessionCallbackToTurnCaller(
      { ...callback, taskId: callback.taskId ?? readTaskIdFromInboxToken(callback.token) },
      input.serializedContext[ActivityObserverKey.name] as ActivityObserverConfig | undefined,
    );
  }

  const ctx = await deserializeContext(input.serializedContext);
  const adapter = ctx.get(ChannelKey);
  if (adapter?.kind !== SUBAGENT_ADAPTER_KIND || !isSubagentAdapterState(adapter.state)) {
    return undefined;
  }

  return {
    callId: adapter.state.callId,
    replyTo: { kind: "hook", token: adapter.state.parentContinuationToken },
    subagentName: adapter.state.subagentName,
    taskId: adapter.state.taskId ?? readTaskIdFromInboxToken(adapter.state.parentContinuationToken),
  };
}

/** Rebinds child event forwarding to the caller that owns the next accepted turn. */
export async function bindTurnCallerContextStep(input: {
  readonly caller: TurnCaller | undefined;
  readonly serializedContext: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  "use step";

  const caller = input.caller;
  if (caller === undefined) {
    if (input.serializedContext[SessionCallbackKey.name] === undefined)
      return input.serializedContext;
    const {
      [SessionCallbackKey.name]: _callback,
      [ActivityObserverKey.name]: _observer,
      ...context
    } = input.serializedContext;
    return context;
  }
  // A new remote caller must not inherit the previous caller's collector or grant.
  const { [ActivityObserverKey.name]: previousObserver, ...withoutActivity } =
    input.serializedContext;
  const observer =
    caller.activityObserver ??
    (caller.replyTo.kind === "hook" &&
    input.serializedContext[SessionCallbackKey.name] === undefined
      ? previousObserver
      : undefined);
  const withActivity =
    observer === undefined
      ? withoutActivity
      : { ...withoutActivity, [ActivityObserverKey.name]: observer };
  if (caller.replyTo.kind === "callback") {
    const callback = attachCallbackOrigin(
      {
        callId: caller.callId,
        subagentName: caller.subagentName,
        token: caller.replyTo.token,
        url: caller.replyTo.url,
      },
      readCallbackOrigin(caller.replyTo),
    );
    return {
      ...withActivity,
      [SessionCallbackKey.name]:
        caller.taskId === undefined ? callback : { ...callback, taskId: caller.taskId },
    };
  }

  const adapter = withActivity[ChannelKey.name];
  if (
    adapter === null ||
    typeof adapter !== "object" ||
    Reflect.get(adapter, "kind") !== SUBAGENT_ADAPTER_KIND ||
    !isSubagentAdapterState(Reflect.get(adapter, "state"))
  ) {
    throw new Error("Delegated local turn is missing its subagent adapter binding.");
  }
  const state = Reflect.get(adapter, "state") as SubagentAdapterState;
  const { taskId: _priorTaskId, ...stateWithoutTaskId } = state;
  const nextState: Record<string, unknown> = {
    ...stateWithoutTaskId,
    callId: caller.callId,
    parentContinuationToken: caller.replyTo.token,
    subagentName: caller.subagentName,
  };
  if (caller.taskId !== undefined) nextState.taskId = caller.taskId;
  const { [SessionCallbackKey.name]: _callback, ...localContext } = withActivity;
  return {
    ...localContext,
    [ChannelKey.name]: {
      ...adapter,
      state: nextState,
    },
  };
}

async function postSettledTurnCallback(input: {
  readonly result: RuntimeSubagentChildResult;
  /** Informational on the wire (tracing); the receiver never verifies it. */
  readonly sessionId: string;
  readonly callbackOrigin?: string;
  readonly url: string;
}): Promise<void> {
  const { sessionId } = input;
  if (input.result.isError === true) {
    await postCallbackPayload({
      payload: {
        callId: input.result.callId,
        error: input.result.output,
        kind: "turn.failed",
        outcome: input.result.outcome,
        sessionId,
        subagentName: input.result.subagentName,
      },
      callbackOrigin: input.callbackOrigin,
      url: input.url,
    });
    return;
  }

  await postCallbackPayload({
    payload: {
      callId: input.result.callId,
      kind: "turn.completed",
      outcome: input.result.outcome,
      output: input.result.output,
      sessionId,
      subagentName: input.result.subagentName,
    },
    callbackOrigin: input.callbackOrigin,
    url: input.url,
  });
}

async function postCallbackPayload(input: {
  readonly payload: unknown;
  readonly callbackOrigin?: string;
  readonly url: string;
}): Promise<void> {
  const response = await postSessionCallbackRequest({
    body: input.payload,
    callbackOrigin: input.callbackOrigin,
    url: input.url,
  });

  if (!response.ok) {
    throw new Error(`Turn callback failed with HTTP ${response.status}.`);
  }
}

async function resumeSettledTurnHook(
  token: string,
  result: RuntimeSubagentChildResult,
): Promise<void> {
  try {
    await resumeHook(token, {
      kind: "runtime-action-result",
      results: [result],
    });
  } catch (error) {
    if (!HookNotFoundError.is(error)) {
      throw error;
    }

    log.warn("turn caller hook no longer exists", {
      callId: result.callId,
      callerToken: token,
    });
  }
}
