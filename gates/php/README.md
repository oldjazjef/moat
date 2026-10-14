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

| File           | Content                                                                         |
| -------------- | ------------------------------------------------------------------------------- |
| `identity.php` | gate id and the gate's X25519 box key (never leaves the server)                 |
| `trust.php`    | pinned signers and threshold (docs/CRYPTO.md §8)                                |
| `policy.php`   | the local policy                                                                |
| `bundle.php`   | the active bundle, exactly as received                                          |
| `state.php`    | the highest version ever accepted (a deleted bundle reopens no rollback)        |
| `limits.php`   | rate-limit counters, keyed by hashes (no IP addresses), at most `maxClients`    |
| `lock.php`     | the lock that serialises updates to `limits.php`                                |
| `webfacts.php` | what the web server process saw of itself, for the hardening check              |
| `log.php`      | the request log, one JSON line per request (below); `logold.php` the one before |
| `setup.php`    | the setup mode: the token's SHA-256, its expiry, the version when switched on   |
| `logkey.php`   | the random key of the request log's client hashes                               |

`install` prints the gate id, the box key and the fingerprints. Compare them, then pin the gate
in the project folder with the `moat gate add` line it prints.

## Commands

```bash
php moat-gate.php policy <policy.json>     # install the local policy (moat policy suggest);
                                           # it lists per host the paths, methods and the
                                           # secrets that may be sent there (SEC-35), and the
                                           # rate limits that always apply (SEC-14)
php moat-gate.php accept <bundle.json>     # verify (steps 1–10) and activate a bundle
php moat-gate.php trust --signer=<pk>[,…] [--threshold=n] [--force]   # replace the pinned signers (key rotation below)
php moat-gate.php pull                     # fetch the bundle from the policy's pull place now (below)
php moat-gate.php status                   # fingerprints, policy, active bundle, pull, kill switch
php moat-gate.php kill [--route=<name>]    # switch the gate or one route off at once (below)
php moat-gate.php revive [--route=<name>]  # and on again (without --route: everything)
php moat-gate.php check [--url=https://…/moat-gate.php]   # the hardening check (below)
php moat-gate.php log [--lines=1000]       # the newest lines of the request log (below)
php moat-gate.php setup                    # the setup mode for 30 minutes, with a new token (below)
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
(FR-18) and, when the route lists its body fields, the body (FR-13, below), adds the upstream's secret, and calls the upstream over HTTPS only: the address is
resolved once, checked to be public and pinned for the connection (SEC-41), no proxy from the
environment, no redirects, TLS verification always on, timeouts and a response size limit. No
client header, cookie or query parameter is forwarded; only the upstream's status, media type and
body come back. Errors are `{"error":"<code>"}`:

| Status | Code                                                                        |
| ------ | --------------------------------------------------------------------------- |
| 400    | `path_invalid`, `body_invalid`, `request_unbounded`                         |
| 401    | `client_unauthorized`                                                       |
| 403    | `origin_forbidden`, `preflight_rejected`                                    |
| 404    | `not_found`                                                                 |
| 405    | `method_not_allowed` (with `Allow`)                                         |
| 413    | `body_too_large`                                                            |
| 415    | `unsupported_media_type`                                                    |
| 429    | `rate_limited`, `quota_exceeded`, `budget_exhausted` (with `Retry-After`)   |
| 500    | `secret_unavailable`, `internal_error`                                      |
| 502    | `upstream_forbidden`, `upstream_unreachable`, `upstream_redirect`,          |
|        | `upstream_content_type`, `upstream_too_large`, `upstream_reflected_secret`, |
|        | `upstream_usage_invalid`, `upstream_auth_failed`                            |
| 503    | `gate_not_configured`, `gate_disabled`, `route_disabled`,                   |
|        | `rate_limit_unavailable`                                                    |
| 504    | `upstream_timeout`                                                          |

The log gets these codes only, never a value.

### Upstream sign-in (FR-20)

An upstream's `auth` adds its secret as a bearer token, a header of its own, a query parameter,
HTTP Basic (`type: basic`, `username`, the secret as password) or OAuth2 client credentials
(`type: oauth2`, `tokenUrl`, `clientId`, optional `scope`). For OAuth2 the gate first POSTs to
`tokenUrl` through the same pinned client, with `client_secret_basic` (RFC 6749 §2.3.1) and
`grant_type=client_credentials`, and sends the API only the access token. The token is kept in
the data file `tokens` until 30 s before it expires (at most an hour, 5 minutes when the answer
says nothing), for this bundle version and these settings only; a 401 from the API drops it. The
file holds access tokens, never the secret, next to `identity`, whose key opens every secret, so
it gets no extra encryption. A token request that fails answers `upstream_auth_failed` (502) and
sends nothing to the API. The policy must allow POST to the token path on its host, with the
secret bound to that host and to the API's host (SEC-35). An answer that contains the Basic
value or the access token is refused like one with the secret (`upstream_reflected_secret`).

### Client protection (FR-16, T-71)

A route's `client` says who may call it; every check that is set must pass, else 401
`client_unauthorized`, the same answer for each:

- `apiKey` (`header`, `secret`): the header compared in constant time with a sealed secret. For
  servers calling the gate, never for a key in a public page. It is no upstream's secret.
- `jwt` (`issuer`, `audience`, `keys`): `Authorization: Bearer <JWT>` signed by a listed key
  (`kid`, `alg` EdDSA, ES256 or RS256 ≥ 2048 bits, `spki` as base64url DER). The algorithm is
  the key's; `iss`, `aud` (or a list containing it) and `exp` are required, `nbf` is respected,
  60 s leeway. ES256 and RS256 need `ext-openssl` (without it: 500 `internal_error`). Apache
  often passes `Authorization` to PHP only with `CGIPassAuth On`.
- `turnstile` (`header`, `secret`, `verifyUrl`): the Cloudflare Turnstile token from the header,
  checked with a POST to `verifyUrl` (Cloudflare's siteverify by default) through the pinned
  client; the policy must allow it like a token endpoint. Unreachable or not `success: true` →
  refused.
- `honeypot` (`field`): a JSON body whose field is there and not `""` or `null` is refused.

API key and JWT are checked before the limits, the honeypot with the body, Turnstile (a call)
last, after the limits and the body.

### Body fields (FR-13, T-65)

A route's `body` in moat.yaml lists the fields of the JSON object the website sends:

```yaml
body:
  email: { type: string, required: true, format: email, maxLength: 254 }
  plan: { type: string, enum: ['free', 'pro'] }
  tags: { type: array, maxItems: 5, items: { type: string, maxLength: 20 } }
```

Types are `string` (`minLength`, `maxLength` in code points, `enum`, `format: email`), `integer`
(`minimum`, `maximum`; strict JSON has no negative numbers or fractions), `boolean`, `object`
(`fields`) and `array` (`items`, `maxItems`, `minItems`); any field can be `required`. At most 64
fields per object, 256 in all, 4 nested levels; only on POST, PUT and PATCH routes that accept
JSON alone. The gate parses the body as strict JSON, keeps only the listed fields at every level and
forwards their canonical JSON (RFC 8785); a missing required field, a wrong type, `null`, a value
out of bounds or anything but a JSON object → 400 `body_invalid`, before anything is sent. A route
with a budget estimates the body it forwards. Without `body` the body goes on as received.

`requireBody: true` under a host in the local policy refuses every bundle with a route to that
host that has no `body` but takes a body (`policy_violation`), whatever its method: such a route
needs `maxBodySize: '0B'`. `moat policy suggest` proposes it once every route to the host
qualifies.

## Locked gate

A gate can be locked from the project: on its own (`moat gate disable website`) or with its whole
environment (`moat env disable staging`). The next bundle then carries `"enabled": false` in its
config, signed like everything else. A locked gate answers **every** request, whatever its method
or path, with 503 `gate_disabled`: no route matching, no CORS answer, nothing forwarded, and
unknown paths get the same answer, so a locked gate reveals no route. `status` and `accept` print
`LOCKED`. Unlocking is a new bundle with a higher version (`moat gate enable`, `moat build`,
`accept`). Cases: [`conformance/http/gate-locked.json`](../../conformance/http/gate-locked.json).

## Kill switch (SEC-15, FR-33, T-23)

The kill switch turns the whole gate or single routes off on the server itself, at once, without
the Cloud and without a new bundle, so it works even when a bundle that locks the gate never
arrives (T-23). It is the data file `kill.php` in the data folder, read on every request:

```bash
php moat-gate.php kill --route=chat     # this route answers 503 route_disabled, the others work
php moat-gate.php kill                  # every request: 503 gate_disabled, like a locked gate
php moat-gate.php revive --route=chat   # this route on again (a killed gate stays off)
php moat-gate.php revive                # everything on again (deletes kill.php)
```

The file holds one entry per line, `gate` or `route <name>`; blank lines and `#` comments are
ignored. A killed gate answers like a locked one (every method and path, preflights included,
nothing forwarded, no route revealed). The switch fails closed: a line the gate does not know, a
file without the data-file marker or one it cannot read turns the **whole gate** off. So without
a command line, uploading an empty `kill.php` into the data folder over FTP turns the gate off,
and deleting it turns it on again. `kill` and `revive` work on the data folder alone, also when
the policy or bundle is missing; a route name the active bundle does not have is noted and kept.
`status` prints what is switched off.

A route kill holds by the route's **name**. That covers a route that misbehaves or is abused, but
not a config you no longer trust: a new bundle could serve the same thing under another name
(`status` warns when a killed name is not in the active bundle). Against a hostile config, kill
the whole gate. Run `kill` as the site's own user: a `kill.php` the web server cannot read turns
the whole gate off (fail closed), and `kill` warns when the file's owner differs from the other
data files.

The local policy can set `"maxConfigAgeSeconds"` (one hour to ten years). `status` then warns when
the active bundle was signed longer ago: a lock that never arrives shows up as a config that stops
changing. It is only a warning; switching off is the kill switch's job. Cases:
[`conformance/http/gate-kill-switch.json`](../../conformance/http/gate-kill-switch.json),
[`conformance/vectors/gate/kill-switch.json`](../../conformance/vectors/gate/kill-switch.json).

## Lazy pull (DT-11, T-64)

Without SSH or FTP for every release, the gate can fetch its bundles itself from a static place
(your own webspace, a bucket). The place is named only in the local policy:

```json
"pull": { "url": "https://bundles.example.com/moat/www.json", "intervalSeconds": 300 }
```

The URL is `https://` with a DNS host name (no IP literal, no user, no query, no fragment) and a
file path of plain segments (`A–Z a–z 0–9 . _ ~ -`, no `.` or `..`); the interval is 60 s to one
day. When the interval is over, the next request fetches the file once, through the same cURL
client as upstream calls (address checked and pinned, no redirects, 5 s, at most 1 MiB), and hands
it to the same checks as `accept`: signature over the received bytes, gate id, a higher version,
schema, policy. The place does not need to be trustworthy: whatever it serves, the worst outcome
is that the active bundle stays. The visitor's request is served either way, with the bundle that
is active after the pull. Concurrent requests fetch at most once per interval: the attempt is
recorded (data file `pull`, codes only) under the lock `pulllock` before the fetch, and accepting
(pulled or by `accept`) takes the same lock, so two bundles never pass the version check at once.
The pull also runs while the kill switch is on, so a fixed bundle can arrive; the kill switch still
decides what is served.

Publishing a release is then: `moat build`, upload the signed bundle to that URL. A lock
(`moat gate disable`) travels the same way. `php moat-gate.php pull` fetches at once, whatever the
interval, and prints what came of it; `status` shows the place and the last attempt, and the log
gets `pull_<outcome> <code>` when a pulled file was not taken. A place that keeps serving the old
file holds back new bundles (T-23): against that, the kill switch and `maxConfigAgeSeconds`.
Cases: [`conformance/http/gate-pull.json`](../../conformance/http/gate-pull.json).

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

## Rate limits and quotas (FR-30, FR-31, SEC-45)

Two layers, both counted on the gate:

1. **The local policy's `limits`** apply to every request, whatever the bundle says (SEC-14,
   T-21): `perIp` per client address, `total` for all clients together. `moat policy suggest`
   proposes 30 requests per minute per IP and 600 in total.
   Optionally `quota` (`{requests: 10000, period: month}`) caps all requests of the gate per
   calendar day or month (T-07): a bundle cannot lift or remove it.
2. **A route's own `rateLimit`** (`{requests: 5, window: '10m'}`, per IP or `per: route`) and
   **`quota`** (`{requests: 1000, period: day}`, for the whole route) can only make it stricter.

A rate-limit window opens with the first request and lasts its length; a quota counts the
calendar day or month in UTC and resets at midnight UTC or on the 1st. A request over a limit gets
`429 rate_limited` with `Retry-After` and is not forwarded; over a quota it gets
`429 quota_exceeded`, with `Retry-After` until the reset. Refused requests do not count. The
client is `REMOTE_ADDR` only, never `X-Forwarded-For` (SEC-26); IPv6 clients count per /64.

The counters live in `limits.php`, at most `maxClients` of them. A counter is only created for a
request that passes `total` (plus one per quota), so the gate can compute how many can be alive at once; a bundle
whose limits could need more than `maxClients` is rejected (`policy_violation`), and `moat policy
suggest` sizes `maxClients` to fit. A flood therefore cannot fill the store. Should it still be
full, damaged, or locked for more than 250 ms, the request gets `503 rate_limit_unavailable`
(SEC-27, fail closed); deleting `limits.php` resets it. A route's counters belong to the route
limits of the bundle in force: a bundle that changes a route's name, rate limit or quota starts
the route counters afresh, so counters of earlier bundles (a quota's lasts up to a month) cannot
fill the store. The policy's counters keep running. The first request after updating from a gate
without quotas starts the store afresh.

## Budgets for AI APIs (FR-31)

A budget caps what an AI API may use per calendar day or month (UTC), counted from the usage
the API reports in its own answer:

```yaml
routes:
  chat:
    # …
    budget:
      usage: openai # where the answer reports its usage: openai, anthropic or gemini
      period: day
      maxOutputTokens: 4000 # the highest max_tokens a request may ask for
      tokens: 200000 # input + output tokens per day
      cost: # optional, in the API's currency
        limit: '5.00'
        inputPerMillion: '2.50' # the provider's price per million input tokens
        outputPerMillion: '10.00'
```

Before forwarding, the gate **checks the request**, since only a bounded request has a known
worst case. The body must be a JSON object without streaming (`stream` absent, `null` or `false`)
and must set its output cap: `openai` `max_tokens`, `max_completion_tokens` or
`max_output_tokens` (every one present is checked, the highest counts; `n` at most 1),
`anthropic` `max_tokens`, `gemini` `generationConfig.maxOutputTokens` (`candidateCount` at most
1). The cap must be a whole number from 1 to `maxOutputTokens` (the smallest of the request's
budgets). `n` and `best_of` must be absent or 1, Gemini requests may not use snake_case keys
(`candidate_count`), and `tools` may only hold tools the client runs (OpenAI `function`,
Anthropic tools without a type or `custom`, Gemini `functionDeclarations`): web search, code
execution and other tools the provider runs are billed per call, which no usage reports.
Anything else is refused with `400 request_unbounded` and nothing is forwarded or charged.

What the gate cannot see in the body is not in the estimate: input the request only points to
(`previous_response_id`, stored files, cached content) is charged once the answer reports it.
Of a key that appears twice, the gate reads the last one, like most JSON parsers.

The request's **estimate** is then its body size in bytes as input tokens (a token is never less
than a byte) plus its cap as output tokens. Once a period's tokens or cost have reached the
limit, the gate answers `429 budget_exhausted` with `Retry-After` until the period ends.
Otherwise it charges the estimate to every budget at once, so requests in flight count too.
After a `2xx` answer it replaces the estimate by the usage the answer reports (`openai`:
`usage.prompt_tokens`/`completion_tokens` or `input_tokens`/`output_tokens`; `anthropic`:
`usage.input_tokens` plus cache writes and reads, `output_tokens`; `gemini`:
`usageMetadata.promptTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount`). An answer that
arrives after its period ended is charged to the new period.

When the request may have reached the API but its answer cannot be counted (a timeout, a broken
connection, an answer too large or not JSON, or one without readable usage, `502
upstream_usage_invalid`), nothing is passed on and the **estimate stays charged**: the provider
may bill that request all the same. An error answer from the API (not `2xx`), or a request that
was never sent (missing secret, forbidden upstream), releases the estimate. A route with a budget
must accept `application/json` answers only, and a bundle may have at most 256 routes with a
budget.

The local policy can set a budget per upstream host that no bundle can lift (SEC-14, T-07), in
tokens only (prices come from the bundle, which could set them to 0):

```json
"api.openai.com": { "pathPrefixes": ["/v1/chat/completions"], "methods": ["POST"], "secrets": ["openai-key"],
                    "budget": { "usage": "openai", "period": "month", "maxOutputTokens": 4000, "tokens": 5000000 } }
```

Every route to that host then counts against it, must answer JSON only, and a route's own budget
must use the same `usage` (`policy_violation` otherwise). `moat policy suggest` proposes this
budget as the sum of the routes' token budgets. The spending lives in `budget.php` (hashed names,
at most 1024 entries, the spending of routes no longer in the bundle dropped); `status` prints
each budget with what it has spent and when it resets. A damaged or full store refuses every
request with a budget (`503 rate_limit_unavailable`); deleting `budget.php` resets the spending.

## Key rotation (SEC-08)

A new signing key replaces the old one in two steps, so the site never stops:

1. `php moat-gate.php trust --signer=<old>,<new>` pins both keys.
2. Sign the next bundle with the new key and activate it (`accept`, or the lazy pull).
3. `php moat-gate.php trust --signer=<new>` pins the new key alone.

`trust` refuses a list that would drop the key of the active bundle, because the gate would then
serve nothing; `--force` does it anyway (a lost or stolen key: the gate stops until a bundle
signed with the new key arrives). Moat Desktop guides through the steps («Schlüssel wechseln»).

## Setup mode (SEC-28, SEC-32, T-73)

`install` switches the setup mode on and prints a token once; `php moat-gate.php setup` does it
again with a new token. While it is on,

```
GET https://<site>/<path>/moat-gate.php?moat-setup
X-Moat-Setup-Token: <token>
```

answers the gate's public identity — `gateId`, `boxKey`, `boxKeyFingerprint`, the pinned `signers`
with their fingerprints, `threshold` and `mode` — so the fingerprints can be compared from Moat
Desktop without a shell on the server (`conformance/http/gate-setup.json`). Nothing in the answer
is secret, and nothing can be changed through it (SEC-40). The data file `setup.php` holds only the
token's SHA-256. The mode switches itself off for good after 30 minutes and as soon as a bundle
above the version accepted when it was switched on arrives; only the command line switches it on
again. Every other answer — no token, a wrong one, the token in the query, another method, the
mode off — is the gate's plain 404 `not_found`. `status` shows whether it is on.

## Request log (FR-50, DT-12, T-72)

After every request the gate appends one JSON line to `log.php`
(`conformance/http/gate-log.json`):

```json
{
  "t": 1792010534,
  "route": "newsletter",
  "method": "POST",
  "status": 200,
  "error": null,
  "ms": 184,
  "client": "b431975193a03e04"
}
```

`route` is null when no route matched, `error` is the gate's code (null when the upstream answered),
`client` a keyed BLAKE2b hash of the client address (IPv4, or the IPv6 /64) and the UTC day: one
client is one id for one day, and the address cannot be read back (the key in `logkey.php` never
leaves the server). There is no path, query, header or body in it. When `log.php` would grow
beyond the policy's `logMaxBytes` (default 262144 bytes, at most 1 MiB), it becomes `logold.php`
and a new one starts; `"logMaxBytes": 0` turns the log off. Writing the log never changes an
answer: when the lock is busy or the disk full, the line is lost.

`php moat-gate.php log` prints the newest lines of both files, oldest first. Moat Desktop reads
that output, or the two data files fetched by SFTP or FTP («Log ansehen» in «Gates»); there is
no endpoint for it (SEC-40).

## Hardening check (SEC-49, SEC-49a)

```bash
php moat-gate.php check --url=https://example.ch/api/moat-gate.php
```

prints the hardening level that is actually in force and every finding with a recommendation.
Exit code 0 for `H1, Basic`, 1 for `H1, Unsafe for secrets`, 3 when no level could be determined.
It combines three sources:

- **The web server process.** Only it knows the user PHP runs as and its `php.ini` (the CLI may
  differ), so the gate records on requests, at most once a day unless something changed, in
  `webfacts.php`: process user (posix), whether it owns the gate file, `open_basedir`, whether it
  may overwrite the gate file, `allow_url_include`. Nothing from the request goes in, and nothing
  is sent anywhere — there is still no inbound management endpoint (SEC-40).
- **The data folder**: group or other permissions on the folder or a data file.
- **From outside** (`--url`, through the one cURL client): `check` leaves a random nonce in
  `checkreq.php` and requests the gate under the URL; the gate's web process copies the nonce into
  its facts. Only then is the URL known to reach this very gate (not a staging copy, not a soft 404
  page). Then the data folder and each data file: a file whose source comes back (the
  `__halt_compiler` marker) or a folder listing that names a data file is `data_reachable`; a
  redirect counts as a failed check.

The classification is `classifyHardening` in libs/core, with the cases in
`conformance/vectors/gate/hardening.json`. The process user is _shared_ when its name is a generic
web server user (`www-data`, `nobody`, …, whoever owns the gate file) or unknown and not the
owner; _per site_ only when the name is known, not generic, and owns the gate file; otherwise
_unclear_. Levels (ANFORDERUNGEN.md §2.9):

| Level                    | When                                                                                                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `H1, Unsafe for secrets` | any `unsafe` finding: a shared user without `open_basedir`, data reachable from outside, a `testing` block                                                                 |
| not determined           | otherwise, when the web process was not seen, its facts are over a week old, the user is unclear, or the check from outside was not run, failed or did not reach this gate |
| `H1, Basic`              | otherwise                                                                                                                                                                  |

H2 and H3 are never reported: the gate keeps its data in the web root. Not yet: the same check
from Moat Desktop against a deployed gate (DT-07).

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

Not built yet: trusted proxies for the client address, a
per-network counter for IPv6 clients holding a whole /56 or /48, the lazy pull
from the Cloud, setup mode, trust mode 2 (passkeys), H2 (data outside the web root).
