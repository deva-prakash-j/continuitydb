# Security policy

## Supported versions

ContinuityDB is pre-1.0 alpha software. Security fixes are made only on the
latest release line.

## Reporting a vulnerability

Do not open a public issue containing an exploit, private repository data,
credentials, tokens, or tenant information. Use the repository host's private
security-advisory feature. Maintainers should acknowledge a complete report
within seven days and publish a coordinated fix/advisory when validated.

Include the affected version, deployment mode, reproduction conditions, impact,
and a minimal secret-free proof. Do not access data that is not yours, degrade a
shared service, or persist access.

## Deployment notice

The default embedded service is for loopback/local use. Network deployment needs
TLS termination, authentication, authorization policy, encrypted storage,
backups, monitoring and a reviewed secret-management path. Read
[the threat model](docs/threat-model.md).

No stored memory grants authority to tools or agents. Agent-facing MCP can make
bounded capture and feedback calls, but cannot approve, correct, delete, change
scope, link graphs or administer storage. Promotion is decided by server policy.
