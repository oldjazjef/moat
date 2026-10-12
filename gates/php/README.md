# Moat Gate for PHP

The gate runs on the website's own hosting (PHP ≥ 8.2 with `sodium`, `curl`, `json`, `hash`). It holds the API secrets, accepts only bundles signed by the keys pinned on the server,
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

| File           | Content                                                                      |
| -------------- | ---------------------------------------------------------------------------- |
| `identity.php` | gate id and the gate's X25519 box key (never leaves the server)              |
| `trust.php`    | pinned signers and threshold (docs/CRYPTO.md §8)                             |
| `policy.php`   | the local policy                                                             |
| `bundle.php`   | the active bundle, exactly as received                                       |
| `state.php`    | the highest version ever accepted (a deleted bundle reopens no rollback)     |
| `limits.php`   | rate-limit counters, keyed by hashes (no IP addresses), at most `maxClients` |
| `lock.php`     | the lock that serialises updates to `limits.php`                             |

`install` prints the gate id, the box key and the fingerprints. Compare them, then pin the gate
in the project folder with the `moat gate add` line it prints.

## Commands

```bash
php moat-gate.php policy <policy.json>     # install the local policy (moat policy suggest);
                                           # it lists per host the paths, methods and the
                                           # secrets that may be sent there (SEC-35), and the
                                           # rate limits that always apply (SEC-14)
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
| 403    | `origin_forbidden`, `preflight_rejected`                                   |
| 404    | `not_found`                                                                |
| 405    | `method_not_allowed` (with `Allow`)                                        |
| 413    | `body_too_large`                                                           |
| 415    | `unsupported_media_type`                                                   |
| 429    | `rate_limited` (with `Retry-After`)                                        |
| 500    | `secret_unavailable`, `internal_error`                                     |
| 502    | `upstream_forbidden`, `upstream_unreachable`, `upstream_redirect`,         |
|        | `upstream_content_type`, `upstream_too_large`, `upstream_reflected_secret` |
| 503    | `gate_not_configured`, `gate_disabled`, `route_disabled`,                  |
|        | `rate_limit_unavailable`                                                   |
| 504    | `upstream_timeout`                                                         |

The log gets these codes only, never a value.

## Locked gate

A gate can be locked from the project: on its own (`moat gate disable website`) or with its whole
environment (`moat env disable staging`). The next bundle then carries `"enabled": false` in its
config, signed like everything else. A locked gate answers **every** request, whatever its method
or path, with 503 `gate_disabled`: no route matching, no CORS answer, nothing forwarded, and
unknown paths get the same answer, so a locked gate reveals no route. `status` and `accept` print
`LOCKED`. Unlocking is a new bundle with a higher version (`moat gate enable`, `moat build`,
`accept`). Cases: [`conformance/http/gate-locked.json`](../../conformance/http/gate-locked.json).

## Origins and CORS (FR-15)

A route may list the browser origins allowed to call it from another site:

```yaml
routes:
  newsletter:
    origins: ['https://www.example.ch']
```

- A request whose `Origin` is not in the list gets `403 origin_forbidden`; nothing is forwarded.
- A listed origin gets `Access-Control-Allow-Origin` with exactly that origin and `Vary: Origin`;
  never `*`, never credentials.
- A preflight (`OPTIONS` with `Origin` and `Access-Control-Request-Method`) is answered by the gate
  itself: `204` when a route at that path lists the origin and has the method, and at most
  `Content-Type` is requested; otherwise `403 preflight_rejected`.
- A route without `origins` sends no CORS headers, so browsers on other sites cannot read its
  answers or send it JSON.

The website's own pages send an `Origin` too (on POST), so list the site itself when you list
origins. A request without `Origin` passes, unless the browser marks it `Sec-Fetch-Site:
cross-site` or `same-site` (an `<img src>` or a link on another site). Origin binding stops
browsers, not scripts (T-01, SEC-58); rate limits are what stops scripts.

## Rate limits (FR-30, SEC-45)

Two layers, both counted on the gate:

1. **The local policy's `limits`** apply to every request, whatever the bundle says (SEC-14,
   T-21): `perIp` per client address, `total` for all clients together. `moat policy suggest`
   proposes 30 requests per minute per IP and 600 in total.
2. **A route's own `rateLimit`** (`{requests: 5, window: '10m'}`, per IP or `per: route`) can
   only make it stricter.

A window opens with the first request and lasts its length. A request over a limit gets
`429 rate_limited` with `Retry-After` and is not forwarded; refused requests do not count. The
client is `REMOTE_ADDR` only, never `X-Forwarded-For` (SEC-26); IPv6 clients count per /64.

The counters live in `limits.php`, at most `maxClients` of them. A counter is only created for a
request that passes `total`, so the gate can compute how many can be alive at once; a bundle
whose limits could need more than `maxClients` is rejected (`policy_violation`), and `moat policy
suggest` sizes `maxClients` to fit. A flood therefore cannot fill the store. Should it still be
full, damaged, or locked for more than 250 ms, the request gets `503 rate_limit_unavailable`
(SEC-27, fail closed); deleting `limits.php` resets it.

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

Not built yet: quotas and budgets (FR-31), trusted proxies for the client address, a
per-network counter for IPv6 clients holding a whole /56 or /48, the lazy pull
from the Cloud, setup mode, trust mode 2 (passkeys), the hardening check.
