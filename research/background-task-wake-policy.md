---
issue: https://github.com/vercel/eve/issues/1084
status: implemented
last_updated: "2026-09-17"
---

# Configurable background task wakes

The channel chooses whether successful task results wait for unfinished
siblings; task execution and terminality remain independent of that choice.

## Authoring

```ts
import { eveChannel } from "eve/channels/eve";
import { localDev } from "eve/channels/auth";

export default eveChannel({
  auth: localDev(),
  taskWakePolicy: "single",
});
```

`taskWakePolicy` accepts `"cohort"` (default) or `"single"` on `defineChannel`
and its built-in wrappers. It controls background results for sessions started
on that channel. Agent definitions do not carry this setting: the same agent can
have different wake policies on different channels. Child sessions use their own
channel policy.

## Observable behavior

A cohort contains overlapping tasks, including launches in later user turns.
The existing cohort policy holds successful completions until the cohort settles.
Single policy makes each successful completion eligible without waiting for
unfinished siblings. Results from the same cohort already queued when the parent
becomes available may share a turn. It does not promise one turn per completion.

For tasks A and B, releasing A while B remains gated produces a report for A under
single policy. Releasing B later produces a report for B, with only B's output in
the new reporting context. Cohort policy continues to produce one report after
both are terminal. User input and intervention notifications retain their existing
ordering and remain serviceable with unfinished background work.

## Runtime boundaries

The channel definition validates the wake policy and carries it on its adapter.
Policy-only channels keep a distinct adapter identity for rehydration. Each model
step records its channel policy in durable context so the workflow input queue
can decide eligibility without running the parent model. The queue preserves all
notification identities when it combines ready results; routing may strip task
payloads after caching their terminal views, so reporting uses those identities
to select the delivered results. The parent activity root remains tied to the
first delivered task's creating turn.

Existing task ownership, terminal-state persistence, cancellation, duplicate
suppression, and invocation settlement are unchanged. Regression coverage checks
partial and buffered completions, cross-turn siblings, input ordering, reporting
context, and configuration propagation. A deterministic fixture eval gates two
children independently to check the externally visible single-policy behavior.
