---
"eve": minor
---

Add `taskDeliveryPolicy: "auto" | "cohort"` to channels and schedules. Channels now default to `"auto"`, allowing independently useful reports or silence until related work settles; `"cohort"` preserves grouped delivery and remains the schedule default, with the schedule's own setting taking precedence over its destination channel.
