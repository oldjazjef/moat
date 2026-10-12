---
name: change-gate
description: Change the PHP gate (gates/php) - request handling, SSRF/header protection, secret injection, rate limits, bundle verification, lazy pull, hardening check. Use for any work under gates/php or when a gate behaves wrongly.
---

# Change the PHP gate

The gate runs on shared hosting (H1) and must survive a compromised Cloud. Read CLAUDE.md →
"Security rules" and "PHP standards" before writing code.

1. **Conformance case first** (`conformance/`): the behaviour you add or the bug you fix, plus the
   nearest attack (bypass, oversize, encoding trick). Run it red against the current gate.

2. **Write for PHP 8.2 on shared hosting**: `declare(strict_types=1)`, `final`, typed, no runtime
   dependencies, nothing from the banned list (eval, exec family, unserialize, `@`, dynamic
   include, URL fopen, …). HTTP only through the one cURL client with HTTPS-only protocols, no
   redirects, `CURLOPT_RESOLVE` to the checked IP, timeouts.

3. **Order inside a request** never changes: normalise path → match route exactly → check
   gating (method, origin, client auth, limits, kill switch) → validate body against the route
   schema → build the upstream request from scratch (allowlisted headers only) → inject the
   bound secret → call → filter the response → log without values. Any failure: generic error,
   fail closed.

4. **Secrets**: decrypt as late as possible, `sodium_memzero` after use, never in an exception
   message, log line or response — the planted-secret test checks it.

5. **Bundles**: verify signature over the received bytes, then gate id, then version >
   current, then expiry (if enabled), then JSON-decode with depth/size limits, then schema, then
   policy intersection. Store atomically. On any failure keep the last valid bundle.

6. **Data files on H1** keep the `exit; __halt_compiler();` prefix and the deny files.

7. Unit tests (PHPUnit) + `pnpm check:gate-php` (CS, PHPStan max, PHPUnit, conformance, matrix
   8.2–8.5 in CI) + `pnpm conformance` for the TS side, then `/security-review`.

8. If the change matters for the other gate targets (later Node/.NET), it is already captured by
   the conformance case — say so in the PR.
