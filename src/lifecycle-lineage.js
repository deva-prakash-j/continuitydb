/** Apply the canonical predecessor rule used by local, remote, and generated lifecycle adapters. */
export function linkCheckpointToLatest(checkpoint, latest) {
  const value = { ...checkpoint };
  if (Object.prototype.hasOwnProperty.call(value, "previous_checkpoint_id") || !latest?.handoff) return value;
  // Recall may fall back to a branchless checkpoint; lineage is exact-branch only.
  if ((latest.handoff.branch || null) !== (value.branch || null)) return value;
  if (latest.handoff.checkpoint_id !== value.checkpoint_id) {
    value.previous_checkpoint_id = latest.handoff.checkpoint_id;
  } else if (latest.handoff.previous_checkpoint_id) {
    value.previous_checkpoint_id = latest.handoff.previous_checkpoint_id;
  }
  return value;
}

/** Convert a persistence result into the bounded, truthful lifecycle output contract. */
export function checkpointSaveOutcome(result) {
  const disposition = typeof result?.disposition === "string" ? result.disposition : "missing";
  const status = typeof result?.record?.status === "string" ? result.record.status : "missing";
  const validIdentity = typeof result?.record?.id === "string"
    && typeof result?.handoff?.checkpoint_id === "string";
  const saved = disposition === "active" && status === "active" && validIdentity;
  const duplicate = validIdentity && Boolean(result?.duplicate);
  const accepted = saved || (duplicate && disposition === "superseded" && status === "superseded");
  const reason = typeof result?.reason === "string" && result.reason
    ? result.reason
    : saved ? "handoff is active" : "ContinuityDB returned an invalid handoff save response";
  return {
    saved,
    accepted,
    duplicate,
    disposition,
    status,
    reason,
    ...(validIdentity ? {
      memory_id: result.record.id,
      checkpoint_id: result.handoff.checkpoint_id,
    } : {}),
  };
}
