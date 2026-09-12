/** Apply the canonical predecessor rule used by local, remote, and generated lifecycle adapters. */
export function linkCheckpointToLatest(checkpoint, latest) {
  const value = { ...checkpoint };
  if (Object.prototype.hasOwnProperty.call(value, "previous_checkpoint_id") || !latest?.handoff) return value;
  if (latest.handoff.checkpoint_id !== value.checkpoint_id) {
    value.previous_checkpoint_id = latest.handoff.checkpoint_id;
  } else if (latest.handoff.previous_checkpoint_id) {
    value.previous_checkpoint_id = latest.handoff.previous_checkpoint_id;
  }
  return value;
}
