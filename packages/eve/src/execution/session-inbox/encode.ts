import type {
  DeliverHookPayload,
  SessionCommand,
  SessionTimeoutHookPayload,
} from "#channel/types.js";
import { hasCallbackGrant } from "#internal/callback-auth.js";
import { AgentHandleError } from "#protocol/agent-handle-error.js";
import {
  normalizeCallbackGrants,
  SESSION_INBOX_WIRE_VERSION,
} from "#execution/session-inbox/protocol.v8.js";

type Command = DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload;

/** A granted delivery was rejected before sending to an incompatible consumer. */
export class SessionCallbackIncompatibleError extends Error {
  constructor() {
    super(AgentHandleError.SessionCallbackIncompatible.toJson().error);
    this.name = "SessionCallbackIncompatibleError";
  }
}

export function commandHasCallbackGrant(command: Command): boolean {
  return "caller" in command && hasCallbackGrant(command.caller);
}

/** Never project a granted delivery onto a consumer that would discard its authorization. */
export function encodeSessionInboxCommand(command: Command, declaredVersion: unknown): Command {
  if (!commandHasCallbackGrant(command)) return command;
  if (declaredVersion !== SESSION_INBOX_WIRE_VERSION) {
    throw new SessionCallbackIncompatibleError();
  }
  const payload = { ...command, version: SESSION_INBOX_WIRE_VERSION };
  normalizeCallbackGrants(payload);
  return payload;
}
