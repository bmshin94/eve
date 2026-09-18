import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER } from "#client/types.js";
import { postSessionCallbackRequest } from "#execution/session-callback-request.js";

const callbackUrl = "https://agent.example.com/eve/v1/activity/opaque-token";
const requestContextSymbol = Symbol.for("@vercel/request-context");
const hostEnvs = ["VERCEL_URL", "VERCEL_BRANCH_URL", "VERCEL_PROJECT_PRODUCTION_URL"] as const;
const readRequestContext = vi.fn();
const fetchMock = vi.fn(
  async (_url: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 202 }),
);

function sentHeaders(index = 0) {
  return new Headers(fetchMock.mock.calls[index]?.[1]?.headers);
}

describe("postSessionCallbackRequest", () => {
  beforeEach(() => {
    vi.stubEnv("VERCEL", "1");
    for (const name of hostEnvs) vi.stubEnv(name, undefined);
    vi.stubEnv("VERCEL_URL", "agent.example.com");
    vi.stubEnv("VERCEL_OIDC_TOKEN", " ambient-token ");
    readRequestContext.mockReset();
    vi.stubGlobal(requestContextSymbol, { get: readRequestContext });
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each(hostEnvs)("uses the ambient token for the exact %s origin", async (name) => {
    vi.stubEnv("VERCEL_URL", undefined);
    vi.stubEnv(name, " Agent.Example.com ");

    const response = await postSessionCallbackRequest({ body: { ok: true }, url: callbackUrl });

    expect(response.status).toBe(202);
    expect(readRequestContext).toHaveBeenCalledExactlyOnceWith();
    expect(fetchMock).toHaveBeenCalledWith(callbackUrl, {
      body: '{"ok":true}',
      headers: {
        "content-type": "application/json",
        [VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER]: "ambient-token",
      },
      method: "POST",
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
    expect(sentHeaders().has("authorization")).toBe(false);
  });

  it("prefers the trimmed request token over the environment and incoming authorization", async () => {
    readRequestContext.mockReturnValue({
      headers: {
        "x-vercel-oidc-token": " ambient-request-token ",
        authorization: "Bearer caller-token",
        [VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER]: "caller-protection-token",
      },
    });

    await postSessionCallbackRequest({ body: {}, url: callbackUrl });

    expect(readRequestContext).toHaveBeenCalledExactlyOnceWith();
    expect(sentHeaders().get(VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER)).toBe("ambient-request-token");
    expect(sentHeaders().has("authorization")).toBe(false);
  });

  it("does not substitute incoming authorization or protection headers for missing OIDC", async () => {
    vi.stubEnv("VERCEL_OIDC_TOKEN", undefined);
    readRequestContext.mockReturnValue({
      headers: {
        authorization: "Bearer caller-token",
        [VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER]: "caller-protection-token",
      },
    });

    await postSessionCallbackRequest({ body: {}, url: callbackUrl });

    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ "content-type": "application/json" });
  });

  it.each([undefined, "", "0", "true"])("does not read tokens when VERCEL is %s", async (value) => {
    vi.stubEnv("VERCEL", value);

    await postSessionCallbackRequest({ body: {}, url: callbackUrl });

    expect(readRequestContext).not.toHaveBeenCalled();
    expect(sentHeaders().get(VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER)).toBeNull();
  });

  it.each([
    "https://external.example.com/eve/v1/callback/token",
    "https://agent.example.com:8443/eve/v1/callback/token",
    "https://agent.example.com.attacker.example/eve/v1/callback/token",
    "https://sub.agent.example.com/eve/v1/callback/token",
    "https://agent.example.com@attacker.example/eve/v1/callback/token",
    "https://user:password@agent.example.com/eve/v1/callback/token",
    "https://user@agent.example.com/eve/v1/callback/token",
    "http://agent.example.com/eve/v1/callback/token",
    "ftp://agent.example.com/eve/v1/callback/token",
    "/eve/v1/callback/token",
    "not a URL",
  ])("does not read or attach credentials for %s", async (url) => {
    await postSessionCallbackRequest({ body: {}, url });

    expect(readRequestContext).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ "content-type": "application/json" });
  });

  it.each([
    "https://agent.example.com",
    "user@agent.example.com",
    "agent.example.com/path",
    "agent.example.com?query=1",
    "agent.example.com#fragment",
    "agent.example.com:8443",
    "*.example.com",
  ])(
    "does not silently strip protocol, userinfo, path or port from VERCEL_URL=%s",
    async (host) => {
      vi.stubEnv("VERCEL_URL", host);

      await postSessionCallbackRequest({ body: {}, url: callbackUrl });

      expect(readRequestContext).not.toHaveBeenCalled();
      expect(sentHeaders().get(VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER)).toBeNull();
    },
  );

  it("recognizes the canonical HTTPS default port", async () => {
    await postSessionCallbackRequest({
      body: {},
      url: "https://AGENT.example.com:443/eve/v1/callback/token",
    });

    expect(sentHeaders().get(VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER)).toBe("ambient-token");
  });

  it.each([undefined, "", "   "])(
    "keeps self callbacks header-free with missing credentials: %s",
    async (token) => {
      vi.stubEnv("VERCEL_OIDC_TOKEN", token);

      await postSessionCallbackRequest({ body: {}, url: callbackUrl });

      expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ "content-type": "application/json" });
    },
  );

  it.each(["", "   "])(
    "does not fall back to the environment for a blank request token: %s",
    async (token) => {
      readRequestContext.mockReturnValue({ headers: { "x-vercel-oidc-token": token } });

      await postSessionCallbackRequest({ body: {}, url: callbackUrl });

      expect(sentHeaders().get(VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER)).toBeNull();
    },
  );

  it("falls back to the environment when the request has no OIDC header", async () => {
    readRequestContext.mockReturnValue({ headers: {} });

    await postSessionCallbackRequest({ body: {}, url: callbackUrl });

    expect(sentHeaders().get(VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER)).toBe("ambient-token");
  });

  it.each(["environment", "request context"])(
    "reads rotating %s tokens on every send",
    async (source) => {
      function setToken(token: string) {
        if (source === "environment") vi.stubEnv("VERCEL_OIDC_TOKEN", token);
        else readRequestContext.mockReturnValue({ headers: { "x-vercel-oidc-token": token } });
      }
      setToken("first-token");
      await postSessionCallbackRequest({ body: {}, url: callbackUrl });
      setToken("rotated-token");
      await postSessionCallbackRequest({ body: {}, url: callbackUrl });

      expect(readRequestContext).toHaveBeenCalledTimes(2);
      expect(sentHeaders(0).get(VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER)).toBe("first-token");
      expect(sentHeaders(1).get(VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER)).toBe("rotated-token");
    },
  );

  it.each(["environment", "request context"])(
    "sends an expired %s token unchanged without credential refresh",
    async (source) => {
      const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
        "base64url",
      );
      const payload = Buffer.from(JSON.stringify({ exp: 1, sub: "original-sender" })).toString(
        "base64url",
      );
      const expiredToken = `${header}.${payload}.test-signature`;
      vi.stubEnv("VERCEL_TOKEN", "unrelated-local-credential");
      if (source === "environment") vi.stubEnv("VERCEL_OIDC_TOKEN", expiredToken);
      else readRequestContext.mockReturnValue({ headers: { "x-vercel-oidc-token": expiredToken } });

      await postSessionCallbackRequest({ body: {}, url: callbackUrl });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe(callbackUrl);
      expect(sentHeaders().get(VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER)).toBe(expiredToken);
      expect(sentHeaders().has("authorization")).toBe(false);
      expect(process.env.VERCEL_OIDC_TOKEN).toBe(
        source === "environment" ? expiredToken : " ambient-token ",
      );
    },
  );

  it.each([undefined, 1_234])("preserves the callback timeout: %s", async (timeoutMs) => {
    const timeout = vi.spyOn(AbortSignal, "timeout");

    await postSessionCallbackRequest({ body: {}, url: callbackUrl, timeoutMs });

    expect(timeout).toHaveBeenCalledExactlyOnceWith(timeoutMs ?? 30_000);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(timeout.mock.results[0]?.value);
  });

  it("propagates redirect errors without retrying or following the destination", async () => {
    const error = new TypeError("fetch failed: unexpected redirect");
    fetchMock.mockRejectedValueOnce(error);

    await expect(postSessionCallbackRequest({ body: {}, url: callbackUrl })).rejects.toBe(error);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("error");
  });

  it.each(["agent.example.com", "external.example.com"])(
    "preserves the existing query bypass on %s",
    async (host) => {
      const url = `https://${host}/eve/v1/callback/opaque-token?x-vercel-protection-bypass=existing%2Bsecret&x-vercel-set-bypass-cookie=true`;

      await postSessionCallbackRequest({ body: { token: "callback-token" }, url });

      expect(fetchMock.mock.calls[0]?.[0]).toBe(url);
      expect(fetchMock.mock.calls[0]?.[1]?.body).toBe('{"token":"callback-token"}');
      expect(sentHeaders().has("authorization")).toBe(false);
      expect(sentHeaders().get(VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER)).toBe(
        host === "agent.example.com" ? "ambient-token" : null,
      );
    },
  );
});
