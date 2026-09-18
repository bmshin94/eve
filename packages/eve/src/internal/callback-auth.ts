import type { ActivityObserverConfig, SessionCallback, TurnCaller } from "#channel/types.js";
import { parseSessionCallback } from "#channel/session-callback.js";
import { isPrivateOrReservedIpAddress } from "#shared/network-address.js";

// Server-owned metadata. Public callback/activity parsers reject this key.
export const CALLBACK_ORIGIN_KEY = "__eveCallbackOrigin";

type CallbackOriginCarrier = { readonly [CALLBACK_ORIGIN_KEY]?: string };

export function readCallbackOrigin(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const origin = (value as CallbackOriginCarrier)[CALLBACK_ORIGIN_KEY];
  if (origin !== undefined && typeof origin !== "string") {
    throw new Error("Invalid stored callback authorization.");
  }
  return origin;
}

export function hasCallbackGrant(caller: TurnCaller | undefined): boolean {
  return (
    readCallbackOrigin(caller?.replyTo) !== undefined ||
    readCallbackOrigin(caller?.activityObserver?.sink) !== undefined
  );
}

export function callbackCredentialOrigin(urlValue: string): string | undefined {
  try {
    const url = new URL(urlValue);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.hostname.includes("*") ||
      isPrivateOrReservedIpAddress(url.hostname)
    )
      return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export function assertCallbackOrigin(url: string, origin: string | undefined): void {
  if (origin !== undefined && (origin === "" || callbackCredentialOrigin(url) !== origin)) {
    throw new Error("Stored callback authorization does not match the destination origin.");
  }
}

export function attachCallbackOrigin<T extends { readonly url: string }>(
  target: T,
  origin: string | undefined,
): T {
  assertCallbackOrigin(target.url, origin);
  return origin === undefined ? target : { ...target, [CALLBACK_ORIGIN_KEY]: origin };
}

/** Called only after strict HTTP parsing and the verified transport-sender policy. */
export function grantCallbackOrigin(
  body: { callback?: SessionCallback; activityObserver?: ActivityObserverConfig },
  trusted: boolean,
): void {
  if (!trusted || body.callback === undefined) return;
  const origin = callbackCredentialOrigin(body.callback.url);
  body.callback = attachCallbackOrigin(body.callback, origin);
  if (body.activityObserver !== undefined) {
    body.activityObserver = {
      ...body.activityObserver,
      sink: attachCallbackOrigin(body.activityObserver.sink, origin),
    };
  }
}

/** Internal durable parser, never used for an HTTP request body. */
export function parseStoredSessionCallback(value: unknown): SessionCallback {
  const origin = readCallbackOrigin(value);
  const publicValue =
    value !== null && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== CALLBACK_ORIGIN_KEY))
      : value;
  const parsed = parseSessionCallback(publicValue);
  if (!parsed.ok) {
    throw new Error("Serialized session callback is invalid.", { cause: parsed.cause });
  }
  return attachCallbackOrigin(parsed.callback, origin);
}

/** Grants belong to this deployment, not to the next remote hop. */
export function publicActivityObserver(
  observer: ActivityObserverConfig | undefined,
): ActivityObserverConfig | undefined {
  if (observer === undefined) return undefined;
  return {
    sink: { url: observer.sink.url, version: observer.sink.version },
    workIdentity: observer.workIdentity,
  };
}
