# moat

API management for websites on ordinary hosting: keeps API secrets out of the frontend, proxies
and gates endpoints, enforces rate limits and budgets. Requirements:
**[ANFORDERUNGEN.md](ANFORDERUNGEN.md)** (cite them as `SEC-41`, `FR-11`, `DT-03`, …).

Four components (ANFORDERUNGEN.md, header):

- **Moat Core** (`libs/core`): the one implementation of schema, bundle building, signing,
  sealing secrets and gate packaging — used by Cloud, Desktop and CLI (DT-02).
- **Moat Cloud** (`apps/api` + `apps/web`): dashboard and management API, SaaS **and**
  self-hosted (Docker Compose, Helm) with the same security architecture (FR-60, SEC-57).
- **Moat Desktop** (`apps/desktop`): the control plane without a server (DT-01). Same features
  as the Cloud for one person, always trust mode 1 or 2.
- **Moat Gate** (`gates/php` first, later `gates/node`, `gates/dotnet`): runs on the customer's
  hosting, enforces everything locally, trusts nobody it does not have to.

> **Status (12.10.2026): requirements v0.3 + this setup.** No code yet. The stack and the
> conventions below are the target; each section becomes concrete when the code lands. Update
> this file whenever the code makes a section concrete or wrong.

**The one rule above all others:** a fully compromised Moat Cloud must not compromise a gate
(ANFORDERUNGEN.md §1, §2.8). Every change is checked against that. When a change would let data
from the Cloud become code, widen the local policy, reveal a secret or lower a gate's trust mode,
it is wrong, whatever the ticket says.

## Stack

Same as **lazy-koins** (`oldjazjef/lazy-koins`), minus its domain (decimal.js engine, tax rules,
PDF/Excel exports, mappings, AI plugin) and minus Firebase (see Auth); plus a PHP gate with its
own toolchain, Postgres for clustered Cloud deployments, and a Helm chart. When in doubt about a
convention, look at how lazy-koins does it.

### Shared (TypeScript)

|                 |                                                                       |
| --------------- | --------------------------------------------------------------------- |
| Node            | **22.23.2**, pinned via Volta in `package.json`                       |
| Package manager | **pnpm 11.21.0**, pinned via `packageManager` — do not use npm        |
| Nx              | 23.2.1 (exact; `@nx/devkit` pinned to match in `pnpm-workspace.yaml`) |
| TypeScript      | 6.0.3                                                                 |
| Tests           | **Vitest** everywhere (TS) — one runner for every TS project          |
| Validation      | **Zod 4** — the config schema and every boundary                      |
| YAML            | **`yaml`** (eemeli) — the only YAML parser, strict options (see YAML) |
| Crypto          | **libsodium** (`libsodium-wrappers-sumo`) — same primitives as PHP    |

### Cloud web (`apps/web`)

Angular 22.2 standalone + zoneless, **spartan.ng** helm components in `libs/ui`, Tailwind CSS v4,
typed reactive forms + Zod, `httpResource` + ActionRunner, ngx-translate (`de-CH` reference +
`en`), Inter self-hosted — exactly as lazy-koins. Selector prefix **`mt`**.

### Cloud API (`apps/api`)

NestJS 11 (Express), **Prisma 7** with driver adapters, `@nestjs/cqrs`, `@nestjs/swagger` +
Scalar, `class-validator` DTOs, webpack via `@nx/webpack`, Vitest with `unplugin-swc` — as
lazy-koins. Databases: see Database.

### Desktop (`apps/desktop`)

**Electron 42** + electron-builder, the API **in-process** on 127.0.0.1 behind an `app://moat`
protocol, `AUTH_MODE=local` + `LOCAL_MODE=true` + a per-launch access token — the lazy-koins
desktop pattern, copied. Keys and deploy credentials through Electron `safeStorage` (OS keychain,
DT-04). Electron over Tauri: decided by "same stack as lazy-koins" (closes ANFORDERUNGEN.md §5.2).

### CLI (`apps/cli`)

Node, bundled with esbuild into one reproducible file (`moat`), on top of `libs/core` only — no
Nest, no Prisma. The trustworthy path for signing and sealing (SEC-37).

### Gate PHP (`gates/php`) — its own world

|              |                                                                                    |
| ------------ | ---------------------------------------------------------------------------------- |
| PHP          | **≥ 8.2** at runtime (shared hosting); CI matrix 8.2 · 8.3 · 8.4 · 8.5             |
| Extensions   | `sodium`, `curl`, `json`, `hash` — checked at boot, fail closed with a clear error |
| Runtime deps | **none** — Composer is for dev tools only (`require` = `php` + `ext-*`)            |
| Style        | **PER Coding Style 2.0** via PHP-CS-Fixer                                          |
| Analysis     | **PHPStan level max** + strict-rules + disallowed-calls (see PHP)                  |
| Tests        | **PHPUnit** + the shared conformance suite                                         |
| Artifact     | one built file per release, signed (SEC-21, SEC-60)                                |

Revisit the PHP floor when 8.2 leaves security support (31.12.2026).

## Commands

Target set (create them with the scaffold; keep this list true):

```bash
pnpm start:full      # migrations, then API + web
pnpm start:desktop   # desktop in dev
pnpm check           # THE gate for TS: lint + budget + format + yamllint + test + build + typecheck
pnpm check:gate-php  # THE gate for PHP: composer validate + cs + phpstan + phpunit + conformance
pnpm check:all       # both — what CI runs
pnpm test            # all TS unit tests (root Vitest, not via Nx — see Testing)
pnpm test:integration
pnpm conformance     # the conformance suite against libs/core and every gate target present
pnpm schema          # regenerate schema/moat.schema.json from the Zod schema (committed)
pnpm format          # prettier --write .
```

`pnpm check:gate-php` needs `php` ≥ 8.2 and `composer` on the PATH. Run it whenever you touch
`gates/php/`, `conformance/` or `libs/core/src/{bundle,crypto,policy}` — a TS-only change can
still break the gate. The Nx daemon is disabled (`useDaemonProcess: false`), as in lazy-koins.

## Layout

```
apps/api/            # Moat Cloud API — also the desktop's in-process server (as lazy-koins)
apps/web/            # Moat Cloud dashboard (Angular)
apps/desktop/        # Electron shell; src/main/lib = pure, unit-tested helpers
apps/cli/            # `moat` CLI on libs/core
libs/core/           # PURE TypeScript (@moat/core): no Nest/Angular/Prisma/network/fs/clock
  src/config/        #   Zod schema of moat.yaml (+ JSON Schema export), YAML loading
  src/bundle/        #   canonical JSON, bundle envelope, versions, gate binding
  src/crypto/        #   sign/verify, seal/open secrets, key files (Argon2id) — libsodium only
  src/policy/        #   local policy + "config ≤ policy" check (SEC-10, SEC-11)
  src/package/       #   gate install packages: artifact + install files, never generated code
  src/storage/       #   StoragePort + project-folder adapter (DT-03); DB adapters live in apps/api
  src/recipes/       #   recipes (FR-43) as data
libs/ui/             # spartan helm components (GENERATED — vendored)
gates/php/           # the PHP gate: src/, tests/, build/ (single-file build), composer.json
conformance/         # language-neutral cases every implementation must pass (see Conformance)
schema/              # moat.schema.json — generated, committed, versioned
recipes/             # example moat.yaml files per recipe (with the schema modeline)
deploy/compose/      # docker-compose for self-hosting
deploy/helm/moat-cloud/  # Helm chart (values.schema.json, hardened defaults)
tools/eslint-rules/  # workspace lint rules (boundaries)
scripts/             # lint budget, schema generation, dev helpers, build/version
```

## Security rules (from the requirements) — non-negotiable

These are the rules Claude must not break, with the requirement each comes from. A change that
touches any of them names the IDs in its PR description.

1. **Config is data, never code** (SEC-20, SEC-23). No `eval`, no `new Function`, no expression
   language, no template engine that executes anything, no dynamic `include`/`require`/`import`
   of a path that comes from config. Transformations are a closed list of built-in operations.
2. **The gate artifact is fixed** (SEC-21, SEC-22). Nothing ever generates PHP (or JS, or C#)
   source from user or config input. "Generating a gate" = the signed release artifact + data
   files (policy, pinned keys, gate id, bundle). Gate updates never travel over the config
   channel.
3. **Verify the bytes, then parse** (SEC-01, SEC-03). A gate checks signature/authenticity over
   the exact received bytes before it JSON-decodes anything. Never re-serialise to verify.
4. **Monotonic, bound bundles** (SEC-04, SEC-07). A bundle carries version and gate id; the gate
   rejects ≤ current version and any other gate id. Rollback = a new, higher version.
5. **Local policy wins** (SEC-10, SEC-11, SEC-13). The effective config is the intersection of
   bundle and local policy. Nothing from the Cloud can change the policy or a pinned key; trust
   mode changes need local confirmation (SEC-06).
6. **Secrets** (SEC-30–SEC-38): the gate's private key never leaves the gate; secrets are sealed
   on the client with AEAD bound to gate id + secret name; a secret goes only to the upstream it
   is bound to; it never appears in logs, errors, responses, test snapshots or exceptions.
   Zero buffers (`sodium_memzero`, `sodium.memzero`) after use where the language allows.
7. **Fail closed** (SEC-46): any parse error, missing secret, unknown field, failed check →
   reject the request with a generic error code. Never "best effort" forward.
8. **SSRF and HTTP hygiene** (SEC-41–SEC-44): exact route matching, path normalisation before
   matching, HTTPS-only upstreams from the allowlist, resolve and check the IP before connect
   (pin it — `CURLOPT_RESOLVE`), no private/loopback/link-local, no automatic redirects, header
   allow/deny lists both ways, CRLF rejected, size limits and timeouts everywhere.
9. **No admin surface on the gate** (SEC-40). The gate has no inbound management endpoint. Ever.
10. **The Cloud cannot read secrets** (SEC-31, FR-65). No code path in `apps/api` decrypts a
    customer secret; there is no key to do it with. Backups and exports contain ciphertext only.
11. **Constant-time comparisons** for anything secret (`hash_equals`, `sodium.memcmp`), CSPRNG
    only (`random_bytes`, `sodium.randombytes_buf`), no home-made crypto, no other crypto library.
12. **Honesty in the product** (§1.5): the UI shows the trust mode and hardening level that is
    actually in force — never a stronger claim.

When a requirement and a request conflict, stop and ask. Security reviews: `/security-review` on
every PR that touches `libs/core/src/{bundle,crypto,policy}`, `gates/**`, auth, or the desktop's
IPC/protocol.

## Crypto defaults (until the crypto spec exists, ANFORDERUNGEN.md §5.3)

Proposed, not final — change them only together with `conformance/vectors/` and both
implementations:

- Signatures: **Ed25519** (`crypto_sign_detached`). Key ids = first 16 bytes of BLAKE2b of the
  public key, base64url.
- Bundle: JSON envelope `{ "v": 1, "kid", "payload": <base64url of canonical JSON>, "sig" }`;
  canonical JSON = **RFC 8785 (JCS)**. The payload holds `gateId`, `version`, optional
  `expiresAt` (SEC-05, default none) and the config.
- Sealed secrets: X25519 ECDH with the gate key + HKDF-SHA256 → **XChaCha20-Poly1305-IETF**,
  associated data = `moat:secret:v1|<gateId>|<secretName>` (SEC-33). Not `crypto_box_seal` — it
  has no associated data.
- Key files (trust mode 1): **Argon2id** (`crypto_pwhash`, moderate limits) wrapping the Ed25519
  secret key; format versioned.
- Encoding: base64url without padding everywhere in JSON.

## YAML standards

YAML is an **authoring format only**. `moat.yaml` is compiled by `libs/core` into a canonical JSON
bundle; **no gate ever parses YAML** (PHP has no YAML in core, and parsers disagree).

**`moat.yaml` (product config):**

- The **Zod schema in `libs/core/src/config/` is the single source**; `schema/moat.schema.json`
  is generated from it (`pnpm schema`) and committed. A test fails when the committed file is
  stale. Objects are strict (`additionalProperties: false`, SEC-20).
- Required top-level `version: 1`. A breaking change bumps it and ships a migration in core;
  adding an optional field does not.
- Parse with `yaml` in strict mode: YAML 1.2 core schema, `uniqueKeys: true`, `merge: false`,
  **no anchors/aliases** (`maxAliasCount: 0`), **no custom tags**, size and depth limits
  (SEC-24). Errors carry line and column and are i18n keys in the UI.
- Keys are **camelCase** (identical to the JSON bundle). Route, upstream and secret names:
  `^[a-z][a-z0-9-]{0,62}$`.
- Never rely on implicit typing: quote strings that look like other types (`"yes"`, `"no"`,
  `"on"`, `"off"`, `"1.0"`, `"0755"`, `"12:30"`), always quote paths and URLs, and use
  durations as strings with a unit (`"30s"`, `"1d"`). The schema rejects bare booleans or numbers
  where a string is expected — no coercion.
- Secrets never appear in `moat.yaml` — only references (`secret: hubspot-token`). A lint rule in
  core flags values that look like keys or tokens (prefixes like `sk-`, `pat-`, long base64/hex).
- Example files start with `# yaml-language-server: $schema=../schema/moat.schema.json`.
- Comments and key order are preserved when the Desktop/Cloud edits a file (use the `yaml`
  Document API, not parse → stringify).

**Repository YAML (workflows, compose, Helm, pnpm-workspace, …):**

- **Prettier owns formatting** (2 spaces, no tabs). **yamllint** (`.yamllint.yml`, part of
  `pnpm check`) owns the rest: truthy values only `true`/`false`, no duplicate keys, no
  octal-looking values.
- GitHub workflows: **actionlint** (+ shellcheck) in `pnpm check`; actions pinned to a full
  commit SHA with the version as a comment; `permissions:` explicit and minimal per workflow.
- Helm: `helm lint` + `kubeconform` on the rendered chart in CI; `values.schema.json` kept in step
  with `values.yaml`; secure defaults (non-root, `readOnlyRootFilesystem`, dropped capabilities,
  `seccompProfile: RuntimeDefault`, NetworkPolicy on, SEC-57). No secrets in `values.yaml` —
  only names of existing Kubernetes Secrets.
- Compose: images pinned by tag + digest in production examples; no secrets inline, `env_file`
  or Docker secrets only.

## PHP standards (`gates/php`)

Shared hosting is the hardest target (H1, ANFORDERUNGEN.md §2.5). Write for it.

- **Every file**: `declare(strict_types=1);`, namespace `Moat\Gate\…`, PSR-4 under `src/`.
  Classes `final` by default, `readonly` properties/classes where possible, enums for closed
  sets, typed everything (params, returns, properties), no `mixed` unless it is decoded input
  that is validated on the next line.
- **No runtime dependencies.** Composer `require` = `php` + `ext-*` only; `vendor/` never ships.
  The build (`gates/php/build/`) concatenates `src/` into **one file** with a header (version,
  build commit, SHA-256) — no Phar (often disabled on shared hosting).
- **Banned** (PHPStan disallowed-calls + a test that greps the built file): `eval`,
  `assert` with strings, `create_function`, `exec`, `shell_exec`, `system`, `passthru`,
  `proc_open`, `popen`, backticks, `unserialize`, `serialize` for storage, `extract`,
  `parse_str` without result array, `$$variable`, the `@` operator, `include`/`require` with a
  non-literal path, `file_get_contents`/`fopen` on URLs (all HTTP goes through the one cURL
  client), `var_dump`/`print_r`/`var_export` outside tests, `preg_*` on untrusted patterns.
- **Entry point** sets its own safe runtime: `display_errors=0`, an error/exception handler that
  logs without values and answers a generic JSON error (SEC-34, SEC-46), output buffering for
  exact header control. Never trust `php.ini` defaults.
- **HTTP client**: cURL only, `CURLOPT_PROTOCOLS`/`CURLOPT_REDIR_PROTOCOLS` = HTTPS,
  `CURLOPT_FOLLOWLOCATION=false`, `CURLOPT_RESOLVE` to the checked IP, explicit connect and total
  timeouts, `CURLOPT_SSL_VERIFYPEER`/`VERIFYHOST` on and never configurable off.
- **Data files on H1** (no space outside the webroot): data files end in `.php` and start with
  `<?php http_response_code(404); exit; __halt_compiler();` — the gate reads the bytes after the
  marker; the data folder also gets `.htaccess`, `web.config` and an empty `index.php`; random
  folder names. The hardening check (SEC-49) proves from outside that nothing is readable.
- **Files**: atomic writes (temp file in the same folder + `rename`), `flock` for the lazy pull
  lock (§4.3), permissions as tight as the host allows; never write into the gate's own code
  file.
- **Crypto**: ext-sodium only (`sodium_crypto_sign_verify_detached`, `sodium_crypto_aead_*`,
  `sodium_crypto_scalarmult`), `hash_hkdf`, `hash_equals`, `random_bytes`, `sodium_memzero`.
- **Style/analysis**: PHP-CS-Fixer with `@PER-CS2.0` + `@PHP82Migration` (`.php-cs-fixer.dist.php`),
  PHPStan level `max` with `phpstan-strict-rules` and `phpstan-deprecation-rules`, zero baseline
  entries (a baseline may only shrink, like the lint budget). Psalm is not used.
- **Tests**: PHPUnit; unit tests per class plus the conformance runner, which starts the built
  file under `php -S` against a local fake upstream. Never call a real API in tests.
- PHP version features above 8.2 only behind a runtime check, and the CI matrix proves it.

## Conformance

`conformance/` is the contract between Moat Core and every gate (DT-02, FR-05, SEC-63). Plain
JSON, readable without YAML and without any test framework:

- `vectors/` — crypto and format cases: canonical JSON, sign/verify, seal/open (including tampered
  AD), key-file unwrap, bundle accept/reject (wrong gate, lower version, expired, bad signature),
  policy intersection, path normalisation, header filtering.
- `http/` — request → expected upstream call / response cases, run against a real gate process and
  a fake upstream (SSRF, smuggling, CRLF, limits, rate limits, kill switch).

**Every change to gate behaviour starts with a conformance case**, then the TS core, then each
gate. A case is never deleted to make an implementation pass. `libs/core` and every gate target
run the full suite in CI.

## Persistence (API)

Same four layers as lazy-koins: Controller → Service façade → Command/QueryBus → Handler →
Repository **Port** (abstract class) → Prisma adapter. Nothing outside `src/persistence/` imports
Prisma; domain types are hand-written; ports take declarative criteria; ownership/tenant is
checked in the handler and a foreign resource is a **404** (SEC-50). Handler specs run against
in-memory port doubles; a cross-tenant isolation suite covers every endpoint.

## Database

- **SQLite** for the desktop and single-instance self-hosting (one writer, WAL), as lazy-koins.
- **PostgreSQL** for the SaaS and clustered self-hosting (Helm with more than one replica).
- One Prisma schema per provider (`prisma/sqlite/`, `prisma/postgresql/`) with its own migration
  history; a test keeps them structurally equal. CHECK constraints hand-written in the migration
  SQL, as in lazy-koins (copy them back after a table redefinition).
- MySQL/MariaDB (DT-03) later, same pattern.
- The desktop's storage choice (DT-03) is a `StoragePort` in core: project folder (default, files
  + Git), SQLite, external DB. **External backends store ciphertext and signed bundles only.**

## Auth

- **Desktop**: `AUTH_MODE=local` exactly as lazy-koins (no login, 127.0.0.1, access token).
- **Cloud**: Firebase does not fit a self-hosted product. Default proposal: built-in accounts
  (e-mail + password with Argon2id, TOTP, **passkeys/WebAuthn**) plus **OIDC** for SSO (SEC-51);
  SAML later. **Open decision — ask before building.**
- RBAC with a separate **sign/release** permission (SEC-52); scoped, short-lived, revocable API
  tokens (SEC-54); gates authenticate with their own key, no shared secret (SEC-55).

## Testing

As lazy-koins: `pnpm test` runs every TS project through the root `vitest.config.ts` (not via Nx);
integration specs (`*.integration.spec.ts`) against real databases are separate. Plus:

- Security behaviour is tested **as an attacker**: tampered bundles, replay to another gate,
  downgrade, foreign upstream, secret exfiltration attempts, cross-tenant access. Each SEC
  requirement that is implemented has at least one negative test that names its id.
- Fuzz the parsers (YAML loader, bundle decoder, path normaliser, header parser) with
  property-based tests (`fast-check`); PHP gets the same inputs through the conformance corpus.
- A planted-secret fixture (`PLANTED_SECRETS`, as lazy-koins) is asserted absent from every log,
  error and response the tests capture.
- Every bug fix gets a regression test.

## CI

`.github/workflows/ci.yml`: `check` (`pnpm check`), `integration`, **`gate-php`** (matrix 8.2–8.5,
`shivammathur/setup-php`, `pnpm check:gate-php`), `conformance`. The gate lives in
`package.json` — add checks there, never to the YAML alone. Release: signed gate artifact +
checksums + SBOM (SEC-60, SEC-61), images to ghcr, desktop installers per release (as lazy-koins).

## Secrets (repository)

- Never commit `.env`, keys, key files, signing material or real customer configs. Fixtures use
  generated test keys that are clearly marked (`TEST ONLY` in the file) and never used elsewhere.
- `.githooks/pre-commit` refuses staged `.env*` (except `.env.example`), `*.key`, `*.pem`,
  `*.moatkey` and anything under `private/`. Never `--no-verify`.
- If a secret was ever committed: revoke and rotate first, history scrubbing after.
- Security reports: GitHub private vulnerability reporting ([SECURITY.md](SECURITY.md)).

## Open decisions — ask, don't decide

- **Cloud auth** (see Auth).
- **License**: the repo is MIT; the product plan was FSL for the gate and a proprietary Cloud.
- **Crypto spec** (ANFORDERUNGEN.md §5.3) — the defaults above are proposals.
- **Default trust mode** in the Cloud (§5.4) and the product wording (§5.5).
- **Desktop signing / auto-update** (same open point as lazy-koins).
- **Threat model** (§5.1) comes before the first gate code.

## Conventions carried over from lazy-koins

- Nx monorepo, pnpm, Vitest; `pnpm check` is the gate and CI only calls it.
- Feature folders with one page service per page; every visible string an i18n key; colours only
  in `styles.css`; `libs/ui/**` vendored.
- `.eslint-budget.json` (all 0, may only go down); Nx daemon off; LF line endings.
- The Environment gotchas of lazy-koins (Electron/better-sqlite3 ABI pin, `express.json()` trap,
  pnpm `allowBuilds`, Windows CRLF/PowerShell encoding) apply here too — copy them in here as soon
  as the matching code exists.
