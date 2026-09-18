---
"eve": patch
---

Preserve schema composition when compiling tools that reuse another tool's Zod input or output schema. Built agents no longer fail route initialization with `Cannot read properties of undefined (reading 'def')` for these nested schemas.
