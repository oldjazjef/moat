# Moat Gate for PHP

The gate runs on the website's own hosting (PHP ≥ 8.2 with `sodium`, `curl`, `json`, `hash`,
`filter`). It holds the API secrets, accepts only bundles signed by the keys pinned on the server,
and forwards exactly the routes in the bundle that also fit the local policy. It has no inbound
management endpoint (SEC-40): everything below happens on the server's command line.

## Build

```bash
pnpm build:gate-php        # → gates/php/dist/moat-gate.php (one file, no vendor/)
```

The header carries version, commit and the SHA-256 of the rest of the file. The build only
concatenates `src/`; nothing is generated from config (SEC-21).

## Install

Copy `moat-gate.php` into the web root (or a folder below it), then on the server:

```bash
php moat-gate.php install --signer=<public key from `moat keygen`>
```

This creates a data folder `moat-data-<random>/` next to the gate file, with `.htaccess`,
`web.config`, an empty `index.php`, and data files that stop PHP before their content (fetched over
HTTP they answer 404 with an empty body):

| File           | Content                                                                  |
| -------------- | ------------------------------------------------------------------------ |
| `identity.php` | gate id and the gate's X25519 box key (never leaves the server)          |
| `trust.php`    | pinned signers and threshold (docs/CRYPTO.md §8)                         |
| `policy.php`   | the local policy                                                         |
| `bundle.php`   | the active bundle, exactly as received                                   |
| `state.php`    | the highest version ever accepted (a deleted bundle reopens no rollback) |

`install` prints the gate id, the box key and the fingerprints. Compare them, then pin the gate
in the project folder with the `moat gate add` line it prints.

## Commands

```bash
php moat-gate.php policy <policy.json>     # install the local policy (moat policy suggest)
php moat-gate.php accept <bundle.json>     # verify (steps 1–10) and activate a bundle
php moat-gate.php trust --signer=<pk>[,…] [--threshold=n]   # replace the pinned signers
php moat-gate.php status                   # fingerprints, policy, active bundle
```

A bundle is accepted only when its signature is valid for the pinned signers, it is bound to this
gate, its version is higher than any accepted before, its config is valid, and it fits the local
policy. The active bundle is checked again on every request against the current trust and
policy, so narrowing the policy or replacing the signers takes effect at once.

## Requests

The website calls the gate with the route path after the file name:

```
POST /moat-gate.php/newsletter
Content-Type: application/json
```

The gate normalises the path (SEC-42), matches it exactly, checks body size and content type
(FR-18), adds the upstream's secret, and calls the upstream over HTTPS only: the address is
resolved once, checked to be public and pinned for the connection (SEC-41), no proxy from the
environment, no redirects, TLS verification always on, timeouts and a response size limit. No
client header, cookie or query parameter is forwarded; only the upstream's status, media type and
body come back. Errors are `{"error":"<code>"}`:

| Status | Code                                                                       |
| ------ | -------------------------------------------------------------------------- |
| 400    | `path_invalid`                                                             |
| 404    | `not_found`                                                                |
| 405    | `method_not_allowed` (with `Allow`)                                        |
| 413    | `body_too_large`                                                           |
| 415    | `unsupported_media_type`                                                   |
| 500    | `secret_unavailable`, `internal_error`                                     |
| 502    | `upstream_forbidden`, `upstream_unreachable`, `upstream_redirect`,         |
|        | `upstream_content_type`, `upstream_too_large`, `upstream_reflected_secret` |
| 503    | `gate_not_configured`, `route_disabled`                                    |
| 504    | `upstream_timeout`                                                         |

The log gets these codes only, never a value.

## The `testing` block

A local policy may contain `testing: {resolve: {"host:port": "127.0.0.1"}, caFile}` to point an
upstream host at a local stand-in and trust its certificate. The conformance runner and demos use
it. It exists only in the local policy, never in a bundle; `policy` and `status` warn about it.
Never keep it on a gate with real secrets.

## Tests

```bash
pnpm check:gate-php
```

Unit tests, the shared vectors in `conformance/vectors/`, and `conformance/http/gate.json` against
the built file under `php -S` with a fake HTTPS upstream (`tests/Http/`).

Not built yet: CORS, rate limits and budgets, the lazy pull from the Cloud, setup mode, trust
mode 2 (passkeys), the hardening check.
