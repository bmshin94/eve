---
"eve": patch
---

Add `setup` to eval configuration for initializing shared resources before the local agent starts. Return environment overrides and a teardown function to keep resources alive through server shutdown and restore the environment afterward, including on failed runs.
