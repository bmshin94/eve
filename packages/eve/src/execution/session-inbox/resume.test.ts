import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sessionCommandHookToken } from "#execution/session-inbox/address.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";

const resumeHookMock = vi.fn();
const getHookByTokenMock = vi.fn();

vi.mock("#internal/workflow/runtime.js", () => ({
  resumeHook: (...args: unknown[]) => resumeHookMock(...args),
  getHookByToken: (...args: unknown[]) => getHookByTokenMock(...args),
}));

afterEach(() => {
  resumeHookMock.mockReset();
  getHookByTokenMock.mockReset();
});

describe("session inbox resume", () => {
  const origin = "https://parent.example.com";
  const granted = {
    kind: "send" as const,
    payload: { message: "report" },
    caller: {
      callId: "call",
      subagentName: "worker",
      replyTo: {
        kind: "callback" as const,
        token: "opaque",
        url: `${origin}/eve/v1/callback/opaque`,
        __eveCallbackOrigin: origin,
      },
    },
  };

  it("pins a granted delivery to the exact hook advertising v8", async () => {
    const hook = sessionHook("owner-2", "alias", {
      sessionId: "anchor",
      sessionInboxWireVersion: 8,
    });
    getHookByTokenMock.mockResolvedValue(hook);
    resumeHookMock.mockResolvedValue(hook);
    const receipt = await resumeSessionInbox("alias", granted);
    expect(resumeHookMock).toHaveBeenCalledExactlyOnceWith(hook, { ...granted, version: 8 });
    await expect(receipt.sessionId).resolves.toBe("anchor");
  });

  it.each([undefined, 1, 2, 3, 4, 5, 6, 7, 9])(
    "does not resume or downgrade a grant for current hook version %s",
    async (version) => {
      getHookByTokenMock.mockResolvedValue(
        sessionHook("old-owner", "alias", {
          sessionId: "anchor",
          sessionInboxWireVersion: version,
        }),
      );
      await expect(resumeSessionInbox("alias", granted)).rejects.toThrow("Start a new session");
      expect(resumeHookMock).not.toHaveBeenCalled();
    },
  );

  it("resumes the current owner while preserving public session identity", async () => {
    const token = sessionCommandHookToken("session-1");
    const hook = sessionHook("owner-2", token, { sessionId: "session-1" });
    resumeHookMock.mockResolvedValue(hook);

    const receipt = await resumeSessionInbox(token, { kind: "clear" });
    expect(receipt.ownerRunId).toBe("owner-2");
    await expect(receipt.sessionId).resolves.toBe("session-1");
    expect(resumeHookMock).toHaveBeenCalledWith(sessionInboxHookToken(token), { kind: "clear" });
  });

  it("resolves a saved public address through the stable token", async () => {
    const token = sessionCommandHookToken("session-1");
    const hook = sessionHook("owner-2", token, { sessionId: "session-1" });
    resumeHookMock.mockResolvedValue(hook);

    await resumeSessionInbox({ sessionId: "session-1" }, { kind: "compact" });
    expect(resumeHookMock).toHaveBeenCalledWith(sessionInboxHookToken(token), { kind: "compact" });
  });
  it("does not hydrate metadata until an accepted alias caller asks for identity", async () => {
    const metadata = vi.fn(() => Promise.resolve({ sessionId: "anchor" }));
    const acceptance = Promise.withResolvers<{
      readonly runId: string;
      readonly metadata: Promise<unknown>;
    }>();
    resumeHookMock.mockReturnValue(acceptance.promise);
    const delivery = resumeSessionInbox("channel:alias", { kind: "clear" });
    expect(metadata).not.toHaveBeenCalled();
    acceptance.resolve({
      runId: "successor",
      get metadata() {
        return metadata();
      },
    });
    const receipt = await delivery;
    expect(metadata).not.toHaveBeenCalled();
    await expect(receipt.sessionId).resolves.toBe("anchor");
    await expect(receipt.sessionId).resolves.toBe("anchor");
    expect(metadata).toHaveBeenCalledOnce();
    expect(resumeHookMock).toHaveBeenCalledOnce();
  });

  it("never reads metadata for a known session address", async () => {
    resumeHookMock.mockResolvedValue({
      runId: "successor",
      get metadata() {
        throw new Error("Metadata must not be read");
      },
    });
    const receipt = await resumeSessionInbox({ sessionId: "anchor" }, { kind: "clear" });
    await expect(receipt.sessionId).resolves.toBe("anchor");
  });

  it("does not substitute the executor for missing session identity", async () => {
    resumeHookMock.mockResolvedValue({ runId: "successor", metadata: Promise.resolve(undefined) });
    const receipt = await resumeSessionInbox("alias", { kind: "clear" });
    await expect(receipt.sessionId).rejects.toThrow("command accepted");
    expect(resumeHookMock).toHaveBeenCalledOnce();
  });
});

function sessionHook(runId: string, token: string, metadata: Record<string, unknown>) {
  return { metadata: Promise.resolve(metadata), runId, token };
}
