# Repository guidance

This repository is an independently buildable TypeScript ESM API package. Keep
API and worker entrypoints separate, preserve strict TypeScript settings, and
avoid importing source files or workspace packages from outside this package.

At the end of each task, report what changed and include verification evidence
with the exact commands and results. Record any inputs still needed through
one-question-at-a-time wizard prompts. State the next possible step so the next
agent can continue the work safely.
