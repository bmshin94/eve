---
issue: https://github.com/vercel/eve/issues/1084
status: implemented
last_updated: "2026-09-17"
---

# Background task delivery policy

Channels and schedules choose when background results are reported; task execution
and session completion remain independent of that choice.

## Authoring

```ts
import { eveChannel } from "eve/channels/eve";
import { localDev } from "eve/channels/auth";

export default eveChannel({ auth: localDev(), taskDeliveryPolicy: "auto" });
```

`taskDeliveryPolicy: "auto" | "cohort"` is available on channel definitions and
schedule definitions, including Markdown schedule frontmatter. Channels default
to `"auto"`; schedules default to `"cohort"`. A schedule's resolved policy wins over
the channel used to start its sessions. Internal subagent sessions use `"cohort"`.

## Observable behavior

A cohort contains overlapping tasks, including launches in later user turns.
`"cohort"` holds successful completions until that cohort settles, then reports
the results together. `"auto"` allows each ready completion to invoke the parent;
results already queued from the same cohort may share a turn.

For independent tasks A and B, auto can report A while B runs. When A needs B to
produce a useful answer, the parent may stay silent after A and report both after
B settles. This is a model judgment about delivery, not a way to avoid the model
call. The runtime retains available outputs in the task index and includes the
whole cohort in subsequent reporting contexts. Received does not mean reported.
User input and intervention notifications remain serviceable under either policy.

## Runtime boundaries

The channel adapter carries authored configuration. Schedule dispatch scopes its
resolved policy alongside schedule provenance; root session creation copies that
value into the same durable runtime policy slot used by ordinary channel sessions.
The workflow queue reads this slot without loading channel modules. Channel
configuration supplies the value when a session has no schedule override.

Reporting projects cohort state from the existing task index. Auto exposes
available outputs while the cohort is pending and permits an empty delivery.
Cohort reports wait for settlement and require a response. Child calls and
structured outputs retain their explicit output contracts.

Scheduled task-mode sessions check indexed pending tasks as well as newly launched
tasks before finishing. A partial report cannot end the session and cancel siblings.
No separate store of reported or withheld task outputs is introduced.
