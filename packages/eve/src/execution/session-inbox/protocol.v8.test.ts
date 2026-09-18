import { describe, expect, it } from "vitest";
import {
  encodeSessionInboxCommand,
  SessionCallbackIncompatibleError,
} from "#execution/session-inbox/encode.js";
import { decodeSessionInboxPayload } from "#execution/session-inbox/protocol.js";
import { encodeLegacyCommand } from "#execution/legacy-session/inbox.js";
import { attachCallbackOrigin, CALLBACK_ORIGIN_KEY } from "#internal/callback-auth.js";
import type { SessionCommand } from "#channel/types.js";

const origin = "https://parent.example.com:8443";
const command: Extract<SessionCommand, { kind: "send" }> = {
  kind: "send",
  payload: { message: "Alice asks Bob to summarize the report." },
  caller: {
    callId: "call",
    subagentName: "worker",
    replyTo: attachCallbackOrigin(
      { kind: "callback" as const, token: "opaque", url: `${origin}/eve/v1/callback/opaque` },
      origin,
    ),
    activityObserver: {
      sink: attachCallbackOrigin(
        { version: 1 as const, url: `${origin}/eve/v1/activity/abcdefghijklmnopqrstuvwxyz123456` },
        origin,
      ),
    },
  },
};
const roundTrip = (value: unknown) => JSON.parse(JSON.stringify(value));

describe("session inbox v8 callback grants", () => {
  it("preserves both origin grants across encoding, serialization and consumer normalization", () => {
    const encoded = encodeSessionInboxCommand(command, 8);
    const decoded = decodeSessionInboxPayload(roundTrip(encoded));
    expect(encoded).toEqual({ ...command, version: 8 });
    expect(decoded).toMatchObject({ kind: "deliver", caller: command.caller });
    expect(decodeSessionInboxPayload(roundTrip(decoded))).toEqual(decoded);
    expect(JSON.stringify(encoded)).not.toContain("OIDC_TOKEN");
  });

  it.each([undefined, 1, 2, 3, 4, 5, 6, 7])(
    "strips unknown grants from old version %s without mutating it",
    (version) => {
      const old = roundTrip({ ...command, version });
      const decoded = decodeSessionInboxPayload(old);
      expect(JSON.stringify(decoded)).not.toContain(CALLBACK_ORIGIN_KEY);
      expect(old.caller.replyTo).toHaveProperty(CALLBACK_ORIGIN_KEY, origin);
      expect(decoded).toMatchObject({
        kind: "deliver",
        caller: {
          replyTo: {
            url: command.caller!.replyTo.kind === "callback" ? command.caller!.replyTo.url : "",
          },
        },
      });
    },
  );

  it.each([undefined, 0, 1, 2, 3, 4, 5, 6, 7, 9, "8"])(
    "rejects granted delivery to consumer %s before sending",
    (version) => {
      expect(() => encodeSessionInboxCommand(command, version)).toThrow(
        SessionCallbackIncompatibleError,
      );
      expect(() => encodeSessionInboxCommand(command, version)).toThrow("Start a new session");
    },
  );

  it.each([1, 2, 3, 4, 5, 6, 7])(
    "never downgrades a granted delivery through legacy v%s",
    (version) => {
      expect(() => encodeLegacyCommand(command, version)).toThrow(
        "Callback authorization requires",
      );
      expect(
        encodeLegacyCommand({ kind: "send", payload: { message: "hello" } }, version),
      ).toMatchObject({ version, kind: "deliver" });
    },
  );

  it.each(["replyTo", "sink"])(
    "rejects an activity-only or callback-only grant for older consumers: %s",
    (carrier) => {
      const input = roundTrip(command);
      if (carrier === "replyTo") delete input.caller.activityObserver;
      else delete input.caller.replyTo[CALLBACK_ORIGIN_KEY];
      expect(() => encodeSessionInboxCommand(input, 7)).toThrow("Callback authorization requires");
    },
  );

  it.each([
    null,
    7,
    "",
    "http://parent.example.com:8443",
    "https://different.example.com",
    `${origin}/path`,
  ])("rejects malformed or mismatched grant %s", (grant) => {
    for (const carrier of ["replyTo", "sink"]) {
      const input = roundTrip({ ...command, version: 8 });
      const target =
        carrier === "replyTo" ? input.caller.replyTo : input.caller.activityObserver.sink;
      target[CALLBACK_ORIGIN_KEY] = grant;
      expect(() => decodeSessionInboxPayload(input)).toThrow("origin grant");
    }
  });

  it("rejects grants on hook replies and controls", () => {
    const input = roundTrip({ ...command, version: 8 });
    input.caller.replyTo.kind = "hook";
    expect(() => decodeSessionInboxPayload(input)).toThrow("origin grant");
    expect(() => decodeSessionInboxPayload({ ...input, kind: "cancel" })).toThrow("origin grant");
  });

  it("does not add a version or alter ordinary producer commands", () => {
    const input = { kind: "clear" } as const;
    expect(encodeSessionInboxCommand(input, undefined)).toBe(input);
  });
});
