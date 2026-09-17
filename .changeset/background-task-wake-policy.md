---
"eve": minor
---

Channel sessions now deliver ready background task results without waiting for unfinished siblings; set `taskWakePolicy: "cohort"` on the channel to preserve grouped delivery. Schedule-started sessions retain the `"cohort"` default unless the channel explicitly selects `"individual"`, and scheduled task-mode sessions remain alive until their pending tasks settle.
