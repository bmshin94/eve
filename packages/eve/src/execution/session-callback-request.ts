import { createLogger } from "#internal/logging.js";
import { isObject } from "#shared/guards.js";
import { assertCallbackOrigin, callbackCredentialOrigin } from "#internal/callback-auth.js";

const log = createLogger("execution.session-callback");
const SESSION_CALLBACK_TIMEOUT_MS = 30_000;
const VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER = "x-vercel-trusted-oidc-idp-token";
const CALLBACK_OIDC_ERROR =
  "Cannot authenticate trusted callback: no usable Vercel OIDC token. Enable OIDC for the sending Vercel deployment and ensure its request context or VERCEL_OIDC_TOKEN provides a valid token.";
const VERCEL_CALLBACK_HOST_ENVS = [
  "VERCEL_URL",
  "VERCEL_BRANCH_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
] as const;
const VERCEL_REQUEST_CONTEXT = Symbol.for("@vercel/request-context");

/** Posts one framework callback payload with the shared callback transport policy. */
export async function postSessionCallbackRequest(input: {
  readonly body: unknown;
  readonly callbackOrigin?: string;
  /** Set false when the caller owns failure logging, such as best-effort activity. */
  readonly logFailures?: boolean;
  readonly timeoutMs?: number;
  readonly url: string;
}): Promise<Response> {
  const timeoutMs = input.timeoutMs ?? SESSION_CALLBACK_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetch(input.url, {
      body: JSON.stringify(input.body),
      headers: resolveSessionCallbackHeaders(input.url, input.callbackOrigin),
      method: "POST",
      // Do not follow redirects: a validated callback host could otherwise
      // 3xx-bounce the framework to an internal/metadata address after the
      // path/token check has already passed.
      redirect: "error",
      signal,
    });
  } catch (error) {
    // Fetch errors can contain the capability URL or credentials in their
    // cause chain. Log a safe summary, but preserve the original rejection.
    if (input.logFailures !== false) {
      log.error("callback delivery failed", {
        ...callbackLogFields(input),
        failure: signal.aborted ? "timeout" : "transport",
        timeoutMs,
        error: new Error("Callback request failed before receiving a response."),
      });
    }
    throw error;
  }
  if (!response.ok && input.logFailures !== false) {
    log.error("callback delivery failed", {
      ...callbackLogFields(input),
      failure: "http",
      statusCode: response.status,
      error: new Error(`Callback request failed with HTTP ${response.status}.`),
    });
  }
  return response;
}

function callbackLogFields(input: { readonly body: unknown; readonly url: string }) {
  const url = URL.parse(input.url);
  const route = url?.pathname.match(/^(.*?\/(?:callback|activity))\//)?.[1];
  const fields: Record<string, string | number | undefined> = {
    callbackOrigin: url?.origin,
    callbackPath: route === undefined ? "[redacted]" : `${route}/[redacted]`,
  };
  if (isObject(input.body)) {
    for (const key of [
      "kind",
      "callId",
      "taskId",
      "sessionId",
      "childSessionId",
      "subagentName",
      "updateEpoch",
    ]) {
      if (typeof input.body[key] === "string") fields[key] = input.body[key];
    }
    if (typeof input.body.updateIndex === "number") fields.updateIndex = input.body.updateIndex;
  }
  return fields;
}

function resolveSessionCallbackHeaders(
  urlValue: string,
  callbackOrigin: string | undefined,
): Record<string, string> {
  assertCallbackOrigin(urlValue, callbackOrigin);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (process.env.VERCEL !== "1") return headers;

  const origin = callbackCredentialOrigin(urlValue);
  if (origin === undefined) return headers;
  const selfOrigin = VERCEL_CALLBACK_HOST_ENVS.some((name) => {
    const host = process.env[name]?.trim();
    if (!host || !/^[^/\\\\?#@\s*]+$/u.test(host)) return false;
    return callbackCredentialOrigin(`https://${host}`) === origin;
  });
  if (callbackOrigin === undefined && !selfOrigin) return headers;

  // SDK refresh can select local credentials and change the sender's identity.
  const token = readAmbientVercelOidcToken();
  if (token === undefined && callbackOrigin !== undefined) throw new Error(CALLBACK_OIDC_ERROR);
  if (token !== undefined) headers[VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER] = token;
  return headers;
}

function readAmbientVercelOidcToken(): string | undefined {
  const requestContext = (
    globalThis as typeof globalThis & {
      [key: symbol]: { get?(): { headers?: Record<string, string> } | undefined } | undefined;
    }
  )[VERCEL_REQUEST_CONTEXT];
  const token =
    requestContext?.get?.()?.headers?.["x-vercel-oidc-token"] ?? process.env.VERCEL_OIDC_TOKEN;
  const trimmed = token?.trim();
  return trimmed === "" ? undefined : trimmed;
}
