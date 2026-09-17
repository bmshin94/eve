---
"eve": patch
---

Add `defineAgent({ tasks: { wakePolicy: "single" } })` to deliver completed background task results without waiting for unfinished siblings. The default `"cohort"` policy continues to deliver successful results together after overlapping tasks settle.
