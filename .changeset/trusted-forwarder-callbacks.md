---
"eve": patch
---

Expand `eveChannel({ trustedForwarders })` to let accepted transport senders nominate an HTTPS callback origin that receives the child's own current Vercel OIDC token, even without end-user principal forwarding. Grants persist with accepted work and are re-evaluated for new message delegations; input-only answers reject callback/activity binding metadata, and granted continuations require a new session when the existing durable inbox cannot preserve the grant.
