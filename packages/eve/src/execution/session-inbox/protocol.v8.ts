import { isObject } from "#shared/guards.js";

/** Versions 1–7 belong to the frozen legacy driver; v8 adds callback origin grants. */
export const SESSION_INBOX_WIRE_VERSION = 8;
export const SESSION_INBOX_WIRE_VERSION_METADATA_KEY = "sessionInboxWireVersion";

export class SessionInboxPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionInboxPayloadError";
  }
}

/** Workflow-safe validation; IP restrictions are checked at HTTP admission and before POST. */
export function normalizeCallbackGrants(value: Record<string, unknown>): Record<string, unknown> {
  const version = value.version;
  if (
    version !== undefined &&
    (typeof version !== "number" || !Number.isInteger(version) || version < 1 || version > 8)
  ) {
    throw new SessionInboxPayloadError("Unsupported session inbox wire version.");
  }
  const caller = value.caller;
  if (!isObject(caller)) return value;
  const observer = caller.activityObserver;
  if (version !== SESSION_INBOX_WIRE_VERSION) {
    // Old persisted commands never had authority to grant this deployment's credential.
    return {
      ...value,
      caller: {
        ...caller,
        replyTo: withoutGrant(caller.replyTo),
        ...(isObject(observer)
          ? { activityObserver: { ...observer, sink: withoutGrant(observer.sink) } }
          : {}),
      },
    };
  }
  validateDestination(caller.replyTo, "callback", value.kind);
  if (isObject(observer)) validateDestination(observer.sink, "activity", value.kind);
  return value;
}

function withoutGrant(value: unknown): unknown {
  if (!isObject(value)) return value;
  const { __eveCallbackOrigin: _grant, ...rest } = value;
  return rest;
}

function validateDestination(
  value: unknown,
  kind: "callback" | "activity",
  commandKind: unknown,
): void {
  if (!isObject(value) || value.__eveCallbackOrigin === undefined) return;
  let valid = false;
  if (
    (commandKind === "send" || commandKind === "deliver") &&
    typeof value.url === "string" &&
    typeof value.__eveCallbackOrigin === "string" &&
    (kind === "callback"
      ? value.kind === "callback" && typeof value.token === "string"
      : value.version === 1)
  ) {
    try {
      const url = new URL(value.url);
      const origin = new URL(value.__eveCallbackOrigin);
      valid =
        origin.protocol === "https:" &&
        origin.origin === value.__eveCallbackOrigin &&
        url.origin === origin.origin &&
        url.username === "" &&
        url.password === "" &&
        !url.hostname.includes("*");
    } catch {
      // Invalid origins must not become an unauthenticated delivery.
    }
  }
  if (!valid) throw new SessionInboxPayloadError(`Invalid session inbox ${kind} origin grant.`);
}
