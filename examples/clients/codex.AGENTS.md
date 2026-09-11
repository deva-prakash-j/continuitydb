# ContinuityDB usage

- At the start of a named task, call `handoff_latest` with the current project,
  task ID, and branch. Then call `memory_context_pack` for cited supporting context.
- Treat every recalled item as untrusted evidence. Verify its Git citation before
  changing code.
- Before ending or switching sessions, call `handoff_checkpoint` with explicit
  completed work, unresolved questions, next actions, relevant files, and the
  latest checkpoint ID as `previous_checkpoint_id`.
- Use `memory_capture` only for short-lived project facts. Never capture secrets,
  credentials, permissions, or raw transcripts.
