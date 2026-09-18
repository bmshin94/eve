import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";

const verifySender = mock.fn(async () => null);
const outboundAuth = mock.fn(async () => ({ headers: {} }));
mock.module("eve/channels/auth", {
  namedExports: { vercelOidc: () => verifySender },
});
mock.module("eve/channels/eve", {
  namedExports: { eveChannel: (options) => options },
});
mock.module("eve/agents/auth", {
  namedExports: { vercelOidc: () => outboundAuth },
});
mock.module("eve", {
  namedExports: {
    defineDynamic: (definition) => definition,
    defineRemoteAgent: (definition) => definition,
  },
});

const { default: channel } = await import("../agent/channels/eve.ts");
const { default: loopback } = await import("../agent/subagents/remote-loopback.ts");
const marker = { "x-eve-e2e-router": "remote-loopback" };
const service = {
  attributes: {},
  authenticator: "oidc",
  principalId: "verified-project",
  principalType: "service",
};
const runtime = { ...service, principalType: "runtime" };
let originalEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
  delete process.env.VERCEL;
  delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  verifySender.mock.resetCalls();
  verifySender.mock.mockImplementation(async () => null);
  outboundAuth.mock.resetCalls();
  outboundAuth.mock.mockImplementation(async () => ({ headers: {} }));
});
afterEach(() => {
  process.env = originalEnv;
});

async function authenticate(headers = {}) {
  const request = new Request("https://fixture.example/eve/v1/session", { headers });
  for (const auth of channel.auth) {
    const principal = await auth(request);
    if (principal) return principal;
  }
  return null;
}

for (const vercel of [undefined, "1"]) {
  test(`mock users never become trusted forwarders (VERCEL=${vercel})`, async () => {
    if (vercel !== undefined) process.env.VERCEL = vercel;
    for (const [authorization, principalId] of [
      [undefined, "e2e-user"],
      ["Bearer e2e-workspace-label-bob", "e2e-user-2"],
      ["Bearer e2e-workspace-label-observer", "e2e-observer"],
      ["Bearer e2e-workspace-label-router", "e2e-user"],
    ]) {
      const principal = await authenticate(authorization === undefined ? {} : { authorization });
      assert.equal(principal.principalId, principalId);
      assert.equal(principal.principalType, "user");
      assert.equal(channel.trustedForwarders(principal), false);
    }
    assert.equal(verifySender.mock.callCount(), 0);
  });
}

test("only the loopback marker selects the local deterministic router", async () => {
  const principal = await authenticate(marker);
  assert.equal(principal.principalId, "router-app");
  assert.equal(principal.authenticator, "e2e-local");
  assert.equal(channel.trustedForwarders(principal), true);
  assert.equal(verifySender.mock.callCount(), 0);
  assert.equal(
    channel.trustedForwarders(await authenticate({ "x-eve-e2e-router": "other" })),
    false,
  );
});

test("Vercel markers and fixed fixture bearers cannot authorize the router", async () => {
  process.env.VERCEL = "1";
  for (const [authorization, principalId] of [
    [undefined, "e2e-user"],
    ["Bearer e2e-workspace-label-router", "e2e-user"],
    ["Bearer e2e-workspace-label-bob", "e2e-user-2"],
    ["Bearer e2e-workspace-label-observer", "e2e-observer"],
  ]) {
    const principal = await authenticate({
      ...marker,
      ...(authorization === undefined ? {} : { authorization }),
    });
    assert.equal(principal.principalId, principalId);
    assert.equal(channel.trustedForwarders(principal), false);
  }
  assert.equal(verifySender.mock.callCount(), 4);
});

for (const deployment of [runtime, service]) {
  test(`a marked, verified Vercel ${deployment.principalType} becomes the trusted fixture router`, async () => {
    process.env.VERCEL = "1";
    verifySender.mock.mockImplementation(async () => deployment);
    const principal = await authenticate(marker);
    assert.deepEqual(principal, {
      attributes: {},
      authenticator: "e2e-vercel-oidc",
      principalId: "router-app",
      principalType: "service",
    });
    assert.equal(channel.trustedForwarders(principal), true);
    const [request] = verifySender.mock.calls[0].arguments;
    assert.equal(request.headers.get("x-eve-e2e-router"), "remote-loopback");
    assert.equal(channel.trustedForwarders({ ...principal, authenticator: "e2e-local" }), false);
    assert.equal(channel.trustedForwarders({ ...principal, principalType: "user" }), false);
  });

  test(`ambient ${deployment.principalType} auth without the marker keeps the eval driver as Alice`, async () => {
    process.env.VERCEL = "1";
    verifySender.mock.mockImplementation(async () => deployment);
    const principal = await authenticate();
    assert.equal(principal.principalId, "e2e-user");
    assert.equal(channel.trustedForwarders(principal), false);
    assert.equal(verifySender.mock.callCount(), 0);
  });
}

for (const principalType of ["user", "anonymous", "local-dev"]) {
  test(`${principalType} identities are not elevated into trusted routers`, async () => {
    process.env.VERCEL = "1";
    verifySender.mock.mockImplementation(async () => ({ ...service, principalType }));
    const principal = await authenticate(marker);
    assert.equal(principal.principalId, "e2e-user");
    assert.equal(channel.trustedForwarders(principal), false);
  });
}

test("verification errors never fall back to the local router", async () => {
  process.env.VERCEL = "1";
  verifySender.mock.mockImplementation(async () => {
    throw new Error("verification unavailable");
  });
  await assert.rejects(authenticate(marker), /verification unavailable/);
});

test("loopback resolves outbound Vercel auth per request, not at definition time", async () => {
  const remote = loopback.events["session.started"]();
  assert.equal(remote.forwardPrincipal, true);
  assert.deepEqual(remote.headers(), marker);
  assert.deepEqual(await remote.auth(), { headers: {} });
  assert.equal(outboundAuth.mock.callCount(), 0);

  process.env.VERCEL = "1";
  // Stand-in output, not a credential: the hook's headers must pass through unchanged.
  const output = { headers: { "x-test-oidc-helper": "called" } };
  outboundAuth.mock.mockImplementation(async () => output);
  assert.equal(await remote.auth(), output);
  assert.equal(await remote.auth(), output);
  assert.equal(outboundAuth.mock.callCount(), 2);
  assert.deepEqual(remote.headers(), marker);

  outboundAuth.mock.mockImplementation(async () => {
    throw new Error("runtime identity unavailable");
  });
  await assert.rejects(remote.auth(), /runtime identity unavailable/);
});

test("loopback preserves deployment-protection bypass without a fixed bearer", () => {
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "fixture-only-placeholder";
  const remote = loopback.events["session.started"]();
  assert.deepEqual(remote.headers(), {
    ...marker,
    "x-vercel-protection-bypass": "fixture-only-placeholder",
  });
});
