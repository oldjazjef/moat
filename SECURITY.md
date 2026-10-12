# Security Policy

Moat protects API secrets and gates access to upstream APIs. Please report security problems
privately.

## Reporting a Vulnerability

Please do not open a public issue for security problems.
Use GitHub's **"Report a vulnerability"** button under the
[Security tab](https://github.com/oldjazjef/moat/security/advisories/new).
I aim to respond within 7 days.

## Scope

Especially relevant: anything that lets a compromised Moat Cloud affect a gate (running code,
reading secrets, adding upstreams, replaying or downgrading bundles), secret leaks from a gate,
SSRF or request smuggling through a gate, and cross-tenant access in Moat Cloud.
