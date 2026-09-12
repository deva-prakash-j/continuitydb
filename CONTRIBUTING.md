# Contributing

Thanks for improving ContinuityDB.

If you are new to the project, start with a
[`good first issue`](https://github.com/deva-prakash-j/continuitydb/labels/good%20first%20issue)
or discuss an idea before committing to a large change. Usage questions belong
in [GitHub Discussions](https://github.com/deva-prakash-j/continuitydb/discussions).

## Local development

```bash
git clone https://github.com/deva-prakash-j/continuitydb.git
cd continuitydb
npm ci
npm test
```

Run `npm run release:check` before opening a pull request. Standalone binary
tests require the Node version pinned by the release workflow; ordinary source
development supports the versions declared in `package.json`.

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

Small documentation, examples, and client-compatibility improvements are
welcome. Never include real tokens, private repositories, raw memory records,
or employer data in tests, examples, issues, or pull requests.
