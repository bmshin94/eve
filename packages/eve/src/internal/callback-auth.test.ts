import { describe, expect, it } from "vitest";
import { parseSessionCallback } from "#channel/session-callback.js";
import { parseActivitySink } from "#channel/activity-sink.js";
import {
  attachCallbackOrigin,
  callbackCredentialOrigin,
  CALLBACK_ORIGIN_KEY,
  grantCallbackOrigin,
  parseStoredSessionCallback,
  readCallbackOrigin,
} from "#internal/callback-auth.js";

const origin = "https://parent.example.com";
const callback = {
  callId: "call",
  subagentName: "worker",
  token: "opaque",
  url: `${origin}/eve/v1/callback/opaque`,
};

describe("internal callback grants", () => {
  it("separates strict request parsing from stored grant parsing", () => {
    const stored = attachCallbackOrigin(callback, origin);
    expect(parseSessionCallback(stored).ok).toBe(false);
    expect(parseStoredSessionCallback(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
    expect(parseSessionCallback(callback).ok).toBe(true);
    expect(parseStoredSessionCallback(callback)).toEqual(callback);
    const sink = attachCallbackOrigin(
      { url: `${origin}/eve/v1/activity/abcdefghijklmnopqrstuvwxyz123456`, version: 1 as const },
      origin,
    );
    expect(() => parseActivitySink(sink)).toThrow();
  });

  it.each([true, false, 1, null, {}, []])(
    "rejects malformed internal grant %o instead of ignoring it",
    (value) => {
      expect(() =>
        parseStoredSessionCallback({ ...callback, [CALLBACK_ORIGIN_KEY]: value }),
      ).toThrow("Invalid stored callback authorization");
    },
  );

  it.each([
    `${origin}:8443`,
    "https://sub.parent.example.com",
    "https://parent.example.com.other.example",
    "http://parent.example.com",
    "https://user:password@parent.example.com",
  ])("rejects a grant applied to a different destination %s", (url) => {
    expect(() =>
      parseStoredSessionCallback({
        ...callback,
        url: `${url}/eve/v1/callback/opaque`,
        [CALLBACK_ORIGIN_KEY]: origin,
      }),
    ).toThrow("does not match the destination origin");
  });

  it.each([
    "http://parent.example.com",
    "ftp://parent.example.com",
    "https://localhost",
    "https://sub.localhost",
    "https://127.0.0.1",
    "https://2130706433",
    "https://[::1]",
    "https://10.0.0.1",
    "https://169.254.169.254",
    "https://[::ffff:169.254.169.254]",
    "https://[fc00::1]",
    "https://user:secret@parent.example.com",
    "https://*.example.com",
    "/relative",
    "not a url",
  ])("never grants credentials to %s", (url) => {
    expect(callbackCredentialOrigin(url)).toBeUndefined();
    const body = { callback: { ...callback, url: `${url}/eve/v1/callback/opaque` } };
    grantCallbackOrigin(body, true);
    expect(readCallbackOrigin(body.callback)).toBeUndefined();
  });

  it("normalizes HTTPS origins, includes nondefault ports, and copies the grant", () => {
    expect(callbackCredentialOrigin("https://PARENT.example.com:443/path")).toBe(origin);
    expect(callbackCredentialOrigin("https://PARENT.example.com:8443/path")).toBe(`${origin}:8443`);
    const stored = attachCallbackOrigin(callback, origin);
    expect(stored).not.toBe(callback);
    expect(readCallbackOrigin(callback)).toBeUndefined();
    expect(() => parseStoredSessionCallback({ ...stored, token: "mismatch" })).toThrow(
      "Serialized session callback is invalid",
    );
    expect(() => parseStoredSessionCallback({ ...stored, extra: true })).toThrow(
      "Serialized session callback is invalid",
    );
  });
});
