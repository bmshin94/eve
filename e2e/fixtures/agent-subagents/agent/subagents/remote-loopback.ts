import { defineDynamic, defineRemoteAgent } from "eve";
import { vercelOidc } from "eve/agents/auth";

/**
 * A remote agent pointing back at this same deployment, so one fixture plays
 * both sides of a `forwardPrincipal` hop: the create-session request leaves
 * over real HTTP carrying the parent turn's principal and lands on this
 * deployment's eve channel. On Vercel the channel verifies this deployment's
 * OIDC before trusting the marked hop (see `agent/channels/eve.ts`).
 *
 * The URL resolves at runtime to the deployment's own address: `VERCEL_URL`
 * on Vercel, or the dev server's self-published origin locally.
 */
export default defineDynamic({
  events: {
    "session.started": () =>
      defineRemoteAgent({
        description:
          "Remote loopback agent. Call this only when the user explicitly asks to use the remote-loopback agent, passing the user's requested message through unchanged. Never pass `outputSchema`.",
        url: () =>
          process.env.VERCEL_URL !== undefined && process.env.VERCEL_URL !== ""
            ? `https://${process.env.VERCEL_URL}`
            : (process.env.WORKFLOW_LOCAL_BASE_URL ?? "http://127.0.0.1:3000"),
        auth: async () => (process.env.VERCEL === "1" ? vercelOidc()() : { headers: {} }),
        headers: () => {
          const headers: Record<string, string> = {
            "x-eve-e2e-router": "remote-loopback",
          };
          // Preview deployments behind Vercel deployment protection need the
          // bypass header on the self-call; harmless when protection is off.
          const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
          if (bypass !== undefined && bypass !== "") {
            headers["x-vercel-protection-bypass"] = bypass;
          }
          return headers;
        },
        forwardPrincipal: true,
      }),
  },
});
