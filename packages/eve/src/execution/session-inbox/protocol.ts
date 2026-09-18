import type {
  DeliverHookPayload,
  SessionCommand,
  SessionTimeoutHookPayload,
} from "#channel/types.js";

export type DecodedSessionInbox =
  | DeliverHookPayload
  | SessionTimeoutHookPayload
  | Extract<SessionCommand, { readonly kind: "cancel" | "clear" | "compact" | "reset" }>;

import {
  normalizeCallbackGrants,
  SessionInboxPayloadError,
} from "#execution/session-inbox/protocol.v8.js";
export { SessionInboxPayloadError } from "#execution/session-inbox/protocol.v8.js";

/** Normalizes the one authored `send` convenience command into a delivery. */
export function decodeSessionInboxPayload(value: unknown): DecodedSessionInbox {
  if (value === null || typeof value !== "object" || !("kind" in value)) {
    throw new SessionInboxPayloadError("Session inbox payload must be an object with a kind.");
  }
  const payload = normalizeCallbackGrants(value as Record<string, unknown>);
  switch (payload.kind) {
    case "send": {
      if (payload.payload === null || typeof payload.payload !== "object") {
        throw new SessionInboxPayloadError("Session send payload must be an object.");
      }
      const command = payload as Extract<SessionCommand, { readonly kind: "send" }>;
      const delivery: DeliverHookPayload & { version?: number } = {
        auth: command.auth,
        title: command.title,
        caller: command.caller,
        deliveryMetadata:
          command.delivery === undefined ? undefined : [{ ...command.delivery, payloadIndex: 0 }],
        kind: "deliver",
        payloads: [command.payload],
        requestId: command.requestId,
        taskDeliveryId: command.taskDeliveryId,
        turnPolicy: command.turnPolicy,
      };
      if (payload.version === 8) delivery.version = 8;
      return delivery;
    }
    case "deliver": {
      if (!Array.isArray(payload.payloads)) {
        throw new SessionInboxPayloadError("Session delivery payloads must be an array.");
      }
      return { ...payload, kind: "deliver", payloads: payload.payloads };
    }
    case "cancel":
    case "clear":
    case "compact":
    case "reset":
    case "session-timeout":
      return payload as DecodedSessionInbox;
    default:
      throw new SessionInboxPayloadError(
        `Unsupported session inbox payload kind ${JSON.stringify(payload.kind)}.`,
      );
  }
}
