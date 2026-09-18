import { type AuthFn, vercelOidc } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
import type { SessionAuthContext } from "eve/context";

/**
 * Fixture users remain public, but the trusted router can nominate recipients
 * of this deployment's OIDC token. On Vercel it must authenticate a deployment
 * identity through Vercel OIDC; only outside Vercel is the marker sufficient.
 * The nonsecret marker distinguishes remote calls from the eval driver, which
 * may carry the same project's OIDC but must still run as Alice by default.
 * Bob and the grantless observer exercise per-turn user forwarding. None of
 * these mock users may authorize delegation context.
 */
const authenticateVercel = vercelOidc();
const BOB_AUTHORIZATION = "Bearer e2e-workspace-label-bob";
const OBSERVER_AUTHORIZATION = "Bearer e2e-workspace-label-observer";

function createFixtureUserPrincipal(principalId: string): SessionAuthContext {
  return {
    attributes: {},
    authenticator: "e2e-fixture",
    issuer: "e2e",
    principalId,
    principalType: "user",
    subject: principalId,
  };
}

const authenticateRouter: AuthFn<Request> = async (request) => {
  if (request.headers.get("x-eve-e2e-router") !== "remote-loopback") return null;
  if (process.env.VERCEL === "1") {
    const principal = await authenticateVercel(request);
    if (principal?.principalType !== "runtime" && principal?.principalType !== "service") {
      return null;
    }
  }
  return {
    attributes: {},
    authenticator: process.env.VERCEL === "1" ? "e2e-vercel-oidc" : "e2e-local",
    principalId: "router-app",
    principalType: "service",
  };
};

const authenticateBob: AuthFn<Request> = (request) => {
  if (request.headers.get("authorization") !== BOB_AUTHORIZATION) return null;
  return createFixtureUserPrincipal("e2e-user-2");
};

const authenticateObserver: AuthFn<Request> = (request) => {
  if (request.headers.get("authorization") !== OBSERVER_AUTHORIZATION) return null;
  return createFixtureUserPrincipal("e2e-observer");
};

const authenticateDefaultUser: AuthFn<Request> = () => createFixtureUserPrincipal("e2e-user");

export default eveChannel({
  auth: [authenticateRouter, authenticateBob, authenticateObserver, authenticateDefaultUser],
  trustedForwarders: (forwarder) =>
    forwarder.principalType === "service" &&
    forwarder.principalId === "router-app" &&
    forwarder.authenticator === (process.env.VERCEL === "1" ? "e2e-vercel-oidc" : "e2e-local"),
});
