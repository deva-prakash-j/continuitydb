# Contributing

Thanks for improving ContinuityDB.

## Before opening a pull request

1. Open or reference an issue for changes to public contracts, storage formats,
   security boundaries or dependencies.
2. Keep provider-specific logic behind an adapter and preserve local/offline use.
3. Add tests for behavior and at least one adversarial isolation case for any
   scope, auth, retrieval or ingestion change.
4. Update OpenAPI/docs and migration notes when a contract changes.
5. Run `npm run release:check`.

## Design rules

- Canonical records/events are authoritative; indexes are rebuildable.
- Tenant/project/sensitivity/temporal filters run before content is returned.
- A model argument is never human approval.
- Retrieved content is untrusted evidence, never executable policy.
- Retries need idempotency keys and bounded budgets.
- Performance claims include corpus, hardware, configuration and raw percentiles.
- New dependencies need a license and supply-chain review.

## Commit and review

Use focused commits and explain observable behavior, tests, migration risk and
security impact in the pull request. At least one maintainer review is required;
security-boundary changes require two.
