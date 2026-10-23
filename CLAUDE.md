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

> **Status (12.10.2026): requirements v0.5 + threat model v0.1 + crypto spec v0.1.** Code so far:
> the Nx/pnpm workspace; `libs/core` (encodings, strict JSON, JCS, key ids, bundle sign/verify and
> building, sealed secrets, key files, the `moat.yaml` schema and loader, local policy, path and
> content-type rules, environments and locks, comment-preserving `moat.yaml` edits); `apps/cli`
> (`moat keygen|validate|policy suggest|gate add|assign|disable|enable|env add|disable|enable|secret seal|build|version`);
> `conformance/vectors/` and `conformance/http/`; and `gates/php` as a working gate: single-file
> build, CLI (`install|trust|policy|accept|pull|status|check|kill|revive|log`), bundle acceptance (steps 1–10), exact routing,
> the cURL upstream client with SSRF guard, origin binding/CORS, rate limits, request quotas per
> calendar day/month (FR-31: route `quota`, policy `limits.quota`, `quota_exceeded`), token and cost
> budgets for AI APIs (FR-31: route `budget`, policy `upstreams.<host>.budget`, usage read from the
> answer in a closed list of formats, bounded requests only (`request_unbounded`: no stream, a
> `max_tokens` up to `maxOutputTokens`), the estimate charged up front, `budget_exhausted`,
> `upstream_usage_invalid`), request validation (FR-13: route `body` lists the JSON fields with
> type and bounds, `libs/core/src/http/body.ts`; unknown fields removed at every level, the canonical
> JSON forwarded, `body_invalid`; policy `upstreams.<host>.requireBody`), the signed lock
> of a gate or a whole environment (`moat env|gate disable`, `gate_disabled`), the local kill switch
> (SEC-15: `php moat-gate.php kill|revive [--route=]`, the data file `kill`, `killSwitchOf` in
> `libs/core/src/gate/`; policy `maxConfigAgeSeconds` → `status` warns, T-23) and the hardening
> check (`check [--url]`, SEC-49/SEC-49a; `classifyHardening` in `libs/core/src/gate/`), the lazy pull
> (DT-11, T-64: policy `pull: {url, intervalSeconds}` set only locally, `isPullUrl` in core; due
> requests fetch once per interval under `pulllock` through the pinned cURL client and hand the
> bytes to `accept`; data file `pull`, `php moat-gate.php pull`), the request log (FR-50, T-72: one JSON line per request in the data file `log` — route name, method, status, gate error code, ms and a daily client hash, never a path, body or address; rolls over to `logold` past policy `logMaxBytes`; `php moat-gate.php log`; core `gate/request-log.ts` parses and summarises), client protection per route (FR-16, T-71: route `client` — `apiKey`, `jwt` EdDSA/ES256/RS256, `turnstile`, `honeypot`, `client_unauthorized`; `http/client.ts`) and upstream sign-in with Basic and OAuth2 client credentials (FR-20, T-70: data file `tokens`)
> ([gates/php/README.md](gates/php/README.md)). **Moat Desktop, first surface:** Electron shell
> with the API in-process (`apps/api`: the project list in `<MOAT_DATA_DIR>/projects.json`,
> `GET /api/projects`, `GET|DELETE /api/projects/:id`, `POST /api/projects/:id/config/edits` — the closed list of moat.yaml edits: add/lock/unlock environments, lock/unlock and assign gates, add/update/enable/disable/remove routes and add/update/remove upstreams (`setRoute`, `setUpstream` & co. in `libs/core/src/config/edit.ts`), with a `base` hash against lost updates) and the Angular
> UI (`apps/web`: Projekte → workspace with Übersicht incl. Umgebungen, Gates with lock state, Routen;
> Hilfe), and signing a gate's next bundle («Bundle signieren» → the main-process dialog of DT-15,
> `BundleSigningService` + `planBundle` in core) and sealing secrets («Versiegeln» → the seal
> window, `SecretSealingService` + `planSeal`; the value is typed only there), and the setup
> wizard (FR-73, `/app/setup`, progress in `<MOAT_DATA_DIR>/setup.json` via `/api/setup`, a guard
> until it is finished): Sprache, Signaturschlüssel (create in the main-process key window, the
> passphrase typed only there, or choose a `.moatkey`), Erstes Projekt (new folder with core
> `NEW_PROJECT_CONFIG`, or an existing one), Erstes Gate (`POST /api/projects/:id/gates/check`
> shows the box key fingerprint, `POST …/gates` pins it only with that fingerprint; core
> `planGate`), Erstes Recipe (core `RECIPES` + `applyRecipe`, FR-43, as the `applyRecipe` edit;
> `GET /api/recipes`; seal and sign as in «Gates»; `GET /api/projects/:id/policy` = `suggestPolicy`;
> «Testen» = `POST /api/projects/:id/test-request` in `apps/api/src/gate-test/`, desktop only, the main
> process confirms each new address in its own dialog, HTTPS to public addresses pinned after the
> check, T-59), Zusammenfassung. The check from outside in the desktop (DT-07): «Von aussen prüfen»
> (`mt-hardening-check`, in the wizard summary and per gate in «Gates») →
> `POST /api/projects/:id/hardening-check` (same target rules, confirmation and pinned client as
> «Testen»; probe rules in core `gate/external-probe.ts`); it shows «Unsicher für Secrets» when a
> data file is readable and no level otherwise. The test console (FR-42): tab «Test-Konsole» →
> `POST /api/projects/:id/dry-run` → core `planDryRun` + `dryRun` (`gate/dry-run.ts`): the gate's
> answer to one request from moat.yaml and the suggested policy, nothing sent, the secret as
> `<SECRET>`; its spec runs every `conformance/http/` case against it. The deploy package (DT-05, T-66): «Deploy» per gate in «Gates» → «Als ZIP speichern» / «In Ordner ablegen» → IPC `moat:gate:deploy` (ids + target only) → `prepareDeploy` in-process (`DeployPackageService`, core `planDeploy`: the latest bundle verified against the desktop's key, unchanged, + `suggestPolicy` of its config) → the main process's save/folder dialog → `apps/desktop/src/main/lib/deploy.ts` writes a new folder `moat-<gate>-v<n>/` (never replaces) or a stored ZIP (core `package/zip.ts`) with `bundle-v<n>.json`, `policy.json` and `LIESMICH.txt`/`README.txt`. «Per SFTP hochladen» (T-67) opens the main-process SFTP window (`sftp-window.ts`, `lib/sftp.ts` session, `lib/sftp-client.ts` on `ssh2`, no native build): target and password/passphrase typed only there, the host key shown with its type and pinned per host and port on first contact (`ssh-ed25519 SHA256:…`), a failure after `mkdir` reported as `partial`, a changed key refused before sign-in, the package written as a new folder with exclusive creates, SFTP only (no command); targets in `config.json` `sftpTargets`, the secret only as `safeStorage` ciphertext. «Per FTPS hochladen» (T-69) opens the main-process FTPS window (`ftps-window.ts`, `lib/ftps.ts` session, `lib/ftps-client.ts` on `basic-ftp`, pure JS): explicit (`AUTH TLS`) or implicit FTPS, never plain FTP, `PROT P` required; the certificate checked after the handshake and before `USER` (CA-verified for the host, else exactly the pinned `SHA256:…`, shown with subject/issuer and pinned per host and port on first contact); passive only, data always to the control host (the PASV address ignored) over TLS with the control session or the same certificate; a new folder (`MKD`), each file checked absent before `STOR`, `partial` after `MKD`; targets in `config.json` `ftpsTargets`. Tests run a local FTPS server (`lib/ftps-test-server.ts`, certificate made at run time). «Per Git ausliefern» (T-68, `lib/git-deploy.ts`): a folder in a Git working copy (chosen in the main process, remembered in `config.json` `gitTargets`), checked for branch, upstream and `.gitignore`, confirmed in a message box with branch and remote, then the package as a new folder, `git commit --only` of that folder and a push to the upstream; the installed `git` via `execFile` with hooks and fsmonitor off; a failed push answers `committed`. Import (FR-45, DT-17, T-50): «Bundle importieren» / «Paketordner importieren» per gate in «Gates» → IPC `moat:gate:import` (ids + `file`|`folder` only) → the main process's file/folder dialog, `lib/import.ts` reads regular files only (no link, ≤ 4 MiB) and a folder by entry names → `importBundle` in-process (`BundleImportService`, core `planImport` in `storage/import-plan.ts`: verified as the gate would against the desktop's key, gate id, version above the latest, no `__proto__` key; ZIPs through the strict `readZip` in `package/unzip.ts`, deflate via injected zlib; only `bundle-v<n>.json`, `policy.json`, `LIESMICH.txt`, `README.txt` in a package) → the bundle's exact bytes as a new `bundles/<gate>/<n>.json`; the package's policy is ignored. «Log ansehen» per gate in «Gates» (DT-12): IPC `moat:gate:log` (ids only) → the main process's file dialog (`log.php`/`logold.php` or the output of `php moat-gate.php log`, at most two regular files, `lib/request-log.ts`) → `readRequestLog` in-process (`apps/api/src/gate-log/request-log-view.ts`, core `parseRequestLog` + `summariseRequestLog`) → summary per route and the newest 200 lines. «Vom Gate abrufen» in «Erstes Gate» (SEC-28, SEC-32, T-73; desktop only, `mt-gate-fetch`) reads gate id and box key from the gate's setup mode: `POST /api/projects/:id/gates/setup` (`GateSetupCommand` in `apps/api/src/gate-test/`, the URL through `gateSetupTarget` = the `.php` gate file with exactly `?moat-setup`, the token `^[A-Za-z0-9_-]{43}$` only in the header `X-Moat-Setup-Token` via `GateClientPort.setup`, the main process confirms the address like «Testen») → core `parseSetupAnswer` (`gate/setup-answer.ts`: strict JSON, exact keys, the box key's fingerprint recomputed and a differing claim refused); the page shows the fingerprints, whether the desktop's own signer is among the gate's pinned ones, and fills the fields — pinning still needs the confirmed fingerprint. Releases: `.github/workflows/release.yml`, started by hand, unsigned (see CI). Trust mode 2 «Passkey» (docs/CRYPTO.md §7, T-74): core and PHP gate verify WebAuthn ES256 entries and `php moat-gate.php trust|install --passkey=… --rp-id=… --origin=…` pins them (vectors `crypto/webauthn.json`, `trust.json`); **Desktop passkey (T-77):** «Passkey anlegen» and «Mit Passkey signieren» per gate in «Gates» (`bridge.passkey.status|enroll|use`, IPC `moat:passkey:*`, ids/booleans only). Chromium refuses WebAuthn on `app://` (measured), so `src/main/passkey-window.ts` opens the ceremony window on `https://passkey.moat.invalid` (rpId `passkey.moat.invalid`) which the main process itself answers in the in-memory session `moat-passkey`: three static files in `dialogs/`, no network (`lib/passkey.ts` `passkeyRoute`); preloads `passkey-preload.ts` / `passkey-sign-preload.ts`. Enrollment (`lib/passkey-enrollment.ts`, strict CBOR/COSE in `lib/passkey-attestation.ts`) stores credential id + public point in `config.json` `passkey`; gates that sign with it are `passkeyGates`; signing = `lib/passkey-signing.ts` → API `BundleSigningService.signWithPasskey` (`webauthnChallenge` of the payload, `verifyBundle` against the pinned passkey before writing); core `PlanSigner.passkey`/`pinnedSignerOf`, `TrustMode` `'passkey'`. **Honest limit:** Electron has no passkey UI of its own; mode 2 works only if the OS offers Chromium a platform authenticator (probe `isUserVerifyingPlatformAuthenticatorAvailable`), else the window and the page say so and nothing is stored. Tested only with a Chromium virtual authenticator (`MOAT_VIRTUAL_AUTHENTICATOR=1`, unpackaged only; `xvfb-run -a pnpm e2e:desktop-passkey` after `nx run api:build`), never with a real passkey. **Moat Cloud, slice 1 (backend only, `AUTH_MODE=cloud`, `src/bootstrap-cloud.ts`, `src/cloud/`; no image or Helm yet):** accounts (register/login/logout/me/password; Argon2id via libsodium `crypto_pwhash_str`, uniform answers that do not reveal whether an address exists, rate limits in the table `rate_limit`), sessions (256-bit cookie `__Host-moat_session`, HttpOnly/Secure/SameSite=Lax, only the SHA-256 in the DB, idle 12 h / absolute 14 d, revoked on logout and password change; CSRF = Origin/Sec-Fetch-Site check plus `x-moat-csrf` bound to the session), TOTP with hashed recovery codes (`node:crypto`; secret sealed under `MOAT_ACCOUNT_KEY`), organisations with roles Owner/Admin/Editor/Viewer/Billing and the separate release permission (`can()` in `cloud/tenancy/domain/permissions.ts`), org projects (id, name), a foreign tenant's resource is a 404. Persistence: Prisma ports/adapters in `src/persistence/cloud/`, migration `20261015120000_cloud_accounts` in both providers (these tables also appear in the desktop's history files and external sync databases, empty). Matrix: `security/authz-matrix-cloud.ts` + `.spec.ts`; threats T-78–T-83. **Moat Cloud, slice 2 (web, `authMode: 'cloud'` in `env.js`):** the dashboard learns the Cloud mode next to the desktop (`isCloud()` in `core/config/runtime-env.ts`: only the exact value `cloud`, never inside the desktop shell = the bridge; the desktop keeps no sign-in and its routes, guards and tests). `core/auth/`: `AccountSession` (account and CSRF token in memory only, no `localStorage`, no password kept), `csrfInterceptor` (`x-moat-csrf` from login and `GET /auth/me` on every unsafe request to the own API only, T-78) and `sessionEndedInterceptor` (a 401 `unauthenticated` forgets the account and opens the sign-in), `authGuard`/`guestGuard`/`cloudOnly`/`desktopOnly`, `api-error.ts` (the closed list of API codes, each `errors.api.<code>`; an unlisted code or a server text is never shown, SEC-34), `credentials.schema.ts` (Zod, the API's bounds) with `core/forms/zod-validator.ts`. Pages: `/login` (with the code step on `mfa_required`) and `/register` (outside the shell, `features/auth`), then under `/app`: `account` (password, TOTP secret and `otpauth` as text once, recovery codes once, disable; honest note, no trust-mode claim), `organisations` (list, create, switch; `ActiveOrganisation` remembers only the id), `organisations/:orgId/projects` and `…/members` (role select, release switch only for Owners and roles that can hold it, remove with a second click, add by address; `OrgScope` reads `GET /orgs/:id` and hides only what the API's `permissions` do not list). The shell shows the Cloud navigation, «Konto» and «Abmelden»; the setup wizard and `/app/projects` are desktop-only (`canMatch`). Help: cloud-only sections `account` and `organisations` (`HelpSection.only`, left out of the desktop guide). Server entry: `apps/api/src/main-cloud.ts` → `nx run api:build-cloud` / `api:serve-cloud` (development only: `MOAT_DEV=true` fills in a temporary SQLite folder, a random account key, the cheap Argon2id and a cookie without Secure, `cloud-dev-env.ts`; refused with `NODE_ENV=production`, where `validateEnv` also refuses both); it does not serve the dashboard — a reverse proxy puts the built web app and `/api` on one origin. **Not yet:** passkeys/WebAuthn and OIDC for accounts, e-mail verification and invitations (add-member takes an existing address and answers uniformly), password reset, API tokens, gate credentials, billing, deleting a Cloud project in the UI (the audit log and Helm came in slices 4 and 5). Argon2id runs synchronously on the event loop (~0.2 s). **Moat Cloud, slice 3 (self-hosting basics, T-84–T-86):** `src/main-cloud.ts` is the production server entry — runs only as `NODE_ENV=production` (or `MOAT_DEV=true`, refused next to `production`), `validateEnv` + `NAME_FILE` secret files (`MOAT_ACCOUNT_KEY_FILE`, `MOAT_DATABASE_URL_FILE`, `cloud-server/server-settings.ts`), `HOST` (an IP, default 127.0.0.1) / `PORT` / `MOAT_WEB_DIR` (required outside dev), the migrator runs in `CloudDatabase.open`, `SIGTERM`/`SIGINT` → `RunningCloud.shutdown()` (`/readyz` 503, idle connections closed, 10 s grace). `bootstrapCloud({webDir})` serves `dist/apps/web-cloud/browser` (`nx run web:build:cloud`: like the desktop build without critical-CSS inlining, because the CSP has no inline script) from the one origin: `cloud-server/static-site.ts` (GET/HEAD only, dot files ignored, `/api/**` never, generated `env.js` = `authMode: 'cloud'` + same origin and nothing else, SPA fallback only for a path without extension **and** `Accept: text/html`, hashed assets immutable), `cloud-server/security-headers.ts` (CSP `script-src 'self'`, `frame-ancestors 'none'`, nosniff, no-referrer, HSTS + `upgrade-insecure-requests` only with `MOAT_COOKIE_SECURE=true`, Permissions-Policy), `cloud-server/probes.ts` (`/healthz`, `/readyz` as Express middleware before the router: public by design, fixed bodies, not in the authz matrix, see its header). `deploy/docker/Dockerfile` (multi-stage, tag-pinned `node:22.23.2-bookworm-slim`, no digest yet, `USER 1000`, code root-owned, `stage-cloud.mjs` adds the packages Nx misses) and `deploy/compose/` (`docker-compose.yml`: moat-cloud + postgres, Docker secrets from `init-secrets.sh`, `read_only`, `cap_drop: ALL`, `no-new-privileges`, internal `backend` network, `sslmode=verify-full` with an own CA; `README.md` in German). **Slice 4 (Helm, T-84–T-86 apply):** `deploy/helm/moat-cloud/` (Deployment, Service, optional Ingress with required TLS, default-deny NetworkPolicy that refuses to render without `networkPolicy.databaseTo`, PDB; non-root, read-only root, secrets only as names of existing Kubernetes Secrets mounted as files, `image.tag` mandatory and never `latest`; `values.schema.json`; `chart.spec.ts` checks values/schema/templates without `helm`); **written and statically checked only — never rendered with `helm lint`/kubeconform or installed (no `helm` in the authoring environment)**. **Slice 5 (audit log, SEC-53, FR-53, T-87–T-89):** `libs/core/src/audit/audit-log.ts` (pure: `chainAudit`/`verifyAudit`, a closed list of actions with closed details — roles, flags, ids, an address only as its SHA-256 —, SHA-256 chain **per organisation**, domain `moat:audit:v1`), table `audit_entry` (migration `20261017120000_audit_log` in both providers: append-only triggers, TRUNCATE refused on PostgreSQL, no foreign keys so no cascade reaches it), `apps/api/src/cloud/audit/` (`AuditTrail.record()` called inside the tenancy handlers after a change — org create, member add _requested_ (same row for an unknown address, T-79), change, remove, project create/delete; retries a lost seq race; `GET /api/orgs/:orgId/audit` paged, `…/audit/verify` with an optional remembered head, `…/audit/export?format=json|csv` ≤ 5000 rows with `next`, CSV formula guard; permission `audit:read` = Owner and Admin only). Matrix entries, `audit-log.spec.ts`, `audit.handlers.spec.ts`, `audit-http.spec.ts`, `audit-log.integration.spec.ts` (SQLite and PostgreSQL). **Dashboard page (slice 9):** tab «Protokoll» (`features/organisations/pages/audit-page`, only with `audit:read`): paged table (`next` → `after`), «Kette prüfen» (`/audit/verify`, shows the head to write down and the honest limit), JSON/CSV export as downloads; actions and reasons are `audit.*` keys. **Withdrawing an invitation (slice 10, T-79):** `POST /api/orgs/:orgId/invitations/revoke {email}` (`members:manage`, `RevokeInvitationCommand`): 204 whether or not an invitation existed, audit action `invitation.revoke` with the address only as its hash; **there is deliberately no list of invitations** — it would tell an administrator which addresses have no confirmed account (decided 23.10.2026); the members page has a «Einladung zurückziehen» form. **Deleting a gate (slice 10, T-100):** `DELETE /api/orgs/:orgId/projects/:projectId/gates/:gate` (`gate:manage`, `RemoveGateCommand`; secrets, bundles and pull address go with it through the foreign keys, moat.yaml stays; audit action `gate.remove`, migration `20261020120000_audit_gate_remove` widens the action CHECK — SQLite by redefining the table, rows and hashes copied unchanged); the gates page asks twice («Gate löschen» → «Wirklich löschen»). **Project status (slice 11, FR-51/52 as far as Moat Cloud itself knows):** `GET /api/orgs/:orgId/projects/:projectId/status` (`config:read`, `ProjectStatusQuery`; closed list of findings — `no_bundle`, `bundle_unreadable`, `bundle_expired`, `bundle_expiring` (14 days), `release_pending` (managed gates: the plan against the latest bundle has changes), `secrets_missing` (names only), project-level `config_missing`, `config_invalid`, `managed_unavailable`; core `readBundleTimes` reads a stored envelope's times without verifying it) and the tab «Status»; **no traffic, error-rate or latency data and no mail/webhook alerts**: gates report nothing to Moat Cloud (FR-50's reporting is not built), and alerts need a scheduler and an outbound channel. **Not yet:** an external anchor or signature of the head (SEC-59), account events (sign-in, password, TOTP) and read/export events, one transaction for change + row (today two writes: a failed row write fails the request but the change stands), retention. **Image (slice 6):** `deploy/docker/Dockerfile` was **built and run for real** (amd64, Docker 29 in the authoring environment; the proxy's CA had to be injected through a scratch copy of the Dockerfile there, not a Dockerfile problem): `/readyz`, the dashboard, `env.js`, SQLite in `/data`, `--read-only` + `cap-drop ALL`, `MOAT_ACCOUNT_KEY_FILE`, a bad configuration refuses to start naming only the variables. One image, all configuration through environment variables (table in `deploy/docker/README.md`: SQLite single instance or PostgreSQL), OCI labels with `MOAT_VERSION`/`MOAT_COMMIT`. `release.yml` has an `image` job (plain `docker buildx`, no third-party action: build + start + `/readyz` smoke test on amd64, then push amd64+arm64 with provenance and SBOM to `ghcr.io/<owner>/moat-cloud:<version>`, `latest` moved by `publish`; the package is private after its first push, set it public once). **That job and arm64 have never run.** **Gates in the Cloud (slice 7, T-90–T-94):** per Cloud project `cloud_config` (moat.yaml as text with a revision, compare-and-set; `PUT …/config` or the closed edit list `POST …/config/edits`, the same `applyConfigEdit` as Moat Desktop), `cloud_gate` (id, box key, mode), `cloud_secret` (sealed ciphertext only, CHECKed shape, only a higher version replaces), `cloud_bundle` (the envelope as signed, never updated); migration `20261018120000_cloud_gates` in both providers (the unreleased audit migration was amended in place for the new actions). `apps/api/src/cloud/gates/`: **managed** gates (trust mode 0 «Bequem»; label and sentence word for word from §2.9 through `mt-trust-mode-badge`): `MOAT_SIGNING_KEY` (`…_FILE`, an Ed25519 seed, optional; without it only signed gates exist) signs the next bundle after `GET …/gates/:g/release` (preview with an input digest) and `POST …/releases {digest}` — needs the **release** flag, signs nothing that changed since the preview, verifies the envelope as the gate would before storing; **signed** gates (modes 1–3): the customer's public key is pinned, `POST …/bundles` stores an upload verified like the gate does (key, gate id, higher version, ≤ 1 MiB), the Cloud never signs for it; enrolment needs the fingerprint the gate printed (`fingerprint_mismatch`, SEC-32, `gate:manage` = Owner/Admin); secrets arrive sealed (`PUT …/secrets/:name`, `secret:write`), never leave except inside a bundle; `POST …/pull-address` makes the gate's lazy-pull address `/api/pull/<256-bit token>` (only its hash stored, shown once, a new one ends the old, public `GET`, uniform 404). New permissions `config:read|write`, `gate:manage`, `secret:write`, `audit:read`. Dashboard: project page «Gates» and «Konfiguration» (`features/organisations/pages/project-{gates,config}-page`), help section `cloudGates`. **Verified for real:** `scripts/smoke-cloud-flow.mjs` (HTTP flow with an independently computed fingerprint) and `scripts/smoke-gate-interop.mjs` (**the real PHP gate** installed with the Cloud key pinned accepts the Cloud's bundle v1 and v2 and refuses a replay of v1) run against the built Docker image (`scripts/smoke-flow-image.sh`, in CI's `image` job). **Browser sealing and key rotation (T-95):** the gates page seals a typed secret in the browser (`shared/crypto/browser-seal.ts` → `@moat/core` `sealSecret`, loaded on demand; CSP `script-src 'self' 'wasm-unsafe-eval'`; plaintext only in the password field, cleared after use; pasting sealed JSON stays under «details»; the page says that CLI/Desktop protect against a hostile Cloud, SEC-37/SEC-58); the installation signing key rotates with `MOAT_SIGNING_KEY_NEXT_PUBLIC` (announce) → gates pin both → switch the seed → `MOAT_SIGNING_KEY_PREVIOUS_PUBLIC` → retire. **E-mail (slice 8, T-96–T-99):** `MOAT_SMTP_HOST` (+ `MOAT_SMTP_PORT|SECURITY|USER|PASSWORD[_FILE]`, `MOAT_MAIL_FROM`; links start with `MOAT_PUBLIC_ORIGIN`) switches it on; without it accounts count as verified, there is no reset and an invitation applies when the person registers. `apps/api/src/cloud/mail/`: own dependency-free SMTP client (`smtp-client.ts`: TLS always verified, STARTTLS required where chosen, password only over TLS, strict address/subject checks, base64 body, bounded replies, fixed `MailError` names), `MailOutbox` (background, bounded, serial; a failure never fails a request), fixed German/English templates with no typed text in them (`mail-templates.ts`), `AccountMailModule` (global). Tables `account_token` (SHA-256 of a 256-bit token, purpose `verify_email`|`reset_password`, single use by compare-and-set, 24 h / 1 h) and `pending_invitation`, column `account.email_verified_at` (migration `20261019120000_cloud_mail`; the unreleased audit migration got the action `member.join`). Routes `POST /api/auth/verify-email|resend-verification|forgot-password|reset-password` (public, uniform answers, `TOKEN_REDEEM_PER_IP`/`MAIL_FLOW_PER_IP`, per-mailbox mail limits that silently skip), login refuses an unconfirmed account with 403 `email_not_verified` only after the password was right; `AddMember` adds a **verified** account at once, anything else becomes a 14-day invitation applied by `InvitationRedeemer` on verification/reset (no release flag, audit `member.join`, not listed in the member list). Web: `/verify-email` (token from the fragment, used only on a click), `/forgot-password`, `/reset-password`, resend button and reset link on the sign-in page. Tested for real: `mail-http.spec.ts` runs the app against a local SMTP socket, `smtp-tls.spec.ts` shows a self-signed certificate is refused (before the password) for implicit TLS and STARTTLS; Helm `mail.*` + `networkPolicy.smtpTo` and Compose lines (commented) are documented in `deploy/docker/README.md` («E-Mail»); `check-helm` renders mail variants and refuses `mail.security=none`, a missing sender, a missing `smtpTo` and a user without a password Secret. **Not yet:** a real STARTTLS handshake against a CA-signed server (only the refusal path is tested), mails in the user's language (always both), trust mode 2 for Cloud gates, alerts, dashboards (FR-51/52), an external anchor for the audit log, TLS in the image/Compose beyond the Caddy quickstart.
> **Not yet (rest):** TLS in the image/Compose (reverse proxy), e-mail, gates in the Cloud, `helm lint` + kubeconform in CI, Trivy on the image; the image was not built with Docker in the authoring environment (no daemon), only its staged contents were run. Everything else below is **Storage backends (DT-03, T-76):** tab «Verlauf» → `GET|POST /api/projects/:id/history` and `…/history/verify` (`HistoryService`, core `storage/history.ts`): an opt-in, append-only, hash-chained SQLite history per project in `<MOAT_DATA_DIR>/history/`, tamper-evident only; «Externe Datenbank» opens the main-process database window (`database-window.ts`): a PostgreSQL URL typed only there (TLS except localhost, kept as `safeStorage` ciphertext in `config.json` `databaseTargets`), push/pull of moat.yaml, gate files, sealed secrets and signed bundles (`DatabaseSyncService`, core `storage/sync.ts`); pulled bundles are verified like an import, a gate is never pinned from the database, nothing newer is overwritten. Prisma 7 with one schema and migration history per provider (`apps/api/prisma/`), a driver adapter on `node:sqlite`. MySQL/MariaDB not yet (open licence question).
> the target; each section becomes concrete when the code lands. Update this file whenever the code
> makes a section concrete or wrong.

**The one rule above all others:** a fully compromised Moat Cloud must not compromise a gate
(ANFORDERUNGEN.md §1, §2.8). Every change is checked against that. When a change would let data
from the Cloud become code, widen the local policy, reveal a secret or lower a gate's trust mode,
it is wrong, whatever the ticket says.

## Stack

Same as **lazy-koins** (`oldjazjef/lazy-koins`), minus its domain (decimal.js engine, tax rules,
PDF/Excel exports, mappings, AI plugin) and minus Firebase entirely (see Auth); plus a PHP gate with its
own toolchain, Postgres for clustered Cloud deployments, and a Helm chart. When in doubt about a
convention, look at how lazy-koins does it.

### Shared (TypeScript)

|                 |                                                                                                                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node            | **22.23.2**, pinned via Volta in `package.json`                                                                                                                                  |
| Package manager | **pnpm 11.21.0**, pinned via `packageManager` — do not use npm                                                                                                                   |
| Nx              | 23.2.1 (exact; `@nx/devkit` pinned to match in `pnpm-workspace.yaml`)                                                                                                            |
| TypeScript      | 6.0.3                                                                                                                                                                            |
| Tests           | **Vitest** everywhere (TS) — one runner for every TS project                                                                                                                     |
| Validation      | **Zod 4** — the config schema and every boundary                                                                                                                                 |
| YAML            | **`yaml`** (eemeli) — the only YAML parser, strict options (see YAML)                                                                                                            |
| Crypto          | **libsodium** (`libsodium-wrappers-sumo`) — same primitives as PHP; ECDSA P-256 (passkeys, mode 2) only through the platform's Web Crypto (TS) / `ext-openssl` (PHP), see Crypto |

### Cloud web (`apps/web`)

Angular 22.2 standalone + zoneless, **spartan.ng** helm components in `libs/ui`, Tailwind CSS v4,
typed reactive forms + Zod, `httpResource` + ActionRunner, ngx-translate (`de-CH` reference +
`en`), Inter self-hosted — exactly as lazy-koins. Selector prefix **`mt`**.

**Actions in tables and lists** (standard, decided 12.10.2026): a row's actions always sit at its
right end — in a table the last column, `class="mt-actions-cell"` (pinned to the right edge while
the table scrolls sideways), in a list the end of the item. One action is a plain button; two or
more go into a menu behind a "…" icon button. Use `mt-row-actions` (`shared/components/row-actions`,
on the vendored `@moat/ui/dropdown-menu`) for both cases, never loose link buttons under a name. An
action that is not possible right now stays in the menu, disabled, and the row says why. A
destructive action asks once more in the same cell («Wirklich löschen» + «Abbrechen»).

### Cloud API (`apps/api`)

NestJS 11 (Express), **Prisma 7** with driver adapters, `@nestjs/cqrs`, `@nestjs/swagger` +
Scalar, `class-validator` DTOs, webpack via `@nx/webpack`, Vitest with `unplugin-swc` — as
lazy-koins. Databases: see Database.

### Desktop (`apps/desktop`)

**Electron 42** + electron-builder, the API **in-process** on 127.0.0.1 behind an `app://moat`
protocol, `AUTH_MODE=local` + `LOCAL_MODE=true` + a per-launch access token — the lazy-koins
desktop pattern, copied. Keys and deploy credentials through Electron `safeStorage` (OS keychain,
DT-04). Electron over Tauri: decided by "same stack as lazy-koins" (closes ANFORDERUNGEN.md §5.2).

As built: the API refuses any request whose `Host` is not exactly `127.0.0.1:<port>` (DT-16)
or that lacks the per-launch `x-moat-desktop` token; both refusals are the same 403. IPC
handlers answer only the `app://moat` origin (DT-08) and take at most a project id, a gate name
and a language. Signing (DT-15), sealing and creating a key: the page only asks; `src/main/{sign,seal,key}-window.ts` open a modal window
through `DialogSlot` (`dialog-window.ts`) from a local file in `src/dialogs/` with no script of
its own, rendered by its own preload (`sign-preload.ts`, `seal-preload.ts`, `key-preload.ts`,
`textContent` only), whose IPC answers only that window's main frame. The main process reads the
key file (path in `config.json`), calls `signBundle` in-process (never HTTP) with the digest the
person confirmed, and remembers the passphrase only through `safeStorage` with a real keychain
(not Linux `basic_text`). A secret's value is typed only in the seal window and passed as bytes to
`sealSecret` in-process, zeroed after. Pure logic in `src/main/lib/{signing,sealing}.ts`. Everything
is project-based: a project is a folder in the API's project list. A folder is added only in the
main-process dialog, in-process (`addProject` in `apps/api/src/desktop.ts`) — there is no HTTP
route that takes a path. `--project=<dir>` adds and opens a folder for development and
screenshots.

### CLI (`apps/cli`)

Node, bundled with esbuild into one reproducible file (`moat`), on top of `libs/core` only — no
Nest, no Prisma. The trustworthy path for signing and sealing (SEC-37).

### Gate PHP (`gates/php`) — its own world

|              |                                                                                           |
| ------------ | ----------------------------------------------------------------------------------------- |
| PHP          | **≥ 8.2** at runtime (shared hosting); CI matrix 8.2 · 8.3 · 8.4 · 8.5                    |
| Extensions   | `sodium`, `curl`, `json`, `hash` (+ `openssl` only if mode 2 is pinned) — checked at boot |
| Runtime deps | **none** — Composer is for dev tools only (`require` = `php` + `ext-*`)                   |
| Style        | **PER Coding Style 2.0** via PHP-CS-Fixer                                                 |
| Analysis     | **PHPStan level max** + strict-rules + disallowed-calls (see PHP)                         |
| Tests        | **PHPUnit** + the shared conformance suite                                                |
| Artifact     | one built file per release, signed (SEC-21, SEC-60)                                       |

Revisit the PHP floor when 8.2 leaves security support (31.12.2026).

## Commands

Target set (create them with the scaffold; keep this list true):

```bash
pnpm start:full      # migrations, then API + web
pnpm start:desktop   # desktop in dev
pnpm nx run api:serve-cloud  # Cloud API for development (MOAT_DEV=true: temp SQLite, cheap Argon2id, no Secure cookie)
pnpm e2e:desktop-passkey  # Electron: passkey windows + virtual authenticator (xvfb-run -a, after nx run api:build)
pnpm check           # THE gate for TS: lint + budget + format + yamllint + test + build + typecheck
pnpm check:gate-php  # THE gate for PHP: composer validate + cs + phpstan + phpunit + conformance
pnpm check:all       # both — what CI runs
pnpm test            # all TS unit tests (root Vitest, not via Nx — see Testing)
pnpm test:integration # *.integration.spec.ts: SQLite for real, PostgreSQL (see Database)
pnpm db:generate     # the Prisma clients → apps/api/src/generated/ (run by prepare)
pnpm test:authz      # the authorization matrix alone (also part of pnpm check)
pnpm test:dast       # ZAP against a locally started Cloud + gate (needs Docker)
pnpm conformance     # the conformance suite against libs/core and every gate target present
pnpm vectors         # regenerate conformance/vectors/crypto/ from libs/core/scripts/build-vectors.ts
pnpm schema          # regenerate schema/moat.schema.json from the Zod schema (committed)
pnpm build           # the CLI → dist/apps/cli/moat.cjs (`pnpm moat …` runs it)
pnpm build:gate-php  # the single gate file → gates/php/dist/moat-gate.php
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
  src/storage/       #   StoragePort + readProject (DT-03); the fs adapter (FolderStorage) and DB
                     #   adapters live in apps/api/src/persistence
  src/gate/          #   gate-side rules shared by every gate (hardening check, SEC-49)
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
    actually in force — never a stronger claim — with exactly the labels and "if Moat Cloud is
    hacked …" sentences of ANFORDERUNGEN.md §2.9 (i18n keys, no other wording).

When a requirement and a request conflict, stop and ask. Security reviews: `/security-review` on
every PR that touches `libs/core/src/{bundle,crypto,policy}`, `gates/**`, auth, or the desktop's
IPC/protocol.

## Crypto

**[docs/CRYPTO.md](docs/CRYPTO.md) is the spec** (formats, verification order, enrollment, release
signing, test vectors). Change it only together with `conformance/vectors/crypto/` and every
implementation. In short: Ed25519 signatures over `"moat:bundle:v1\n" ‖ payloadBytes` with JCS
payloads; secrets sealed with X25519 + keyed BLAKE2b + XChaCha20-Poly1305, AD bound to gate id,
name and secret version; key files with Argon2id; base64url without padding. Passkeys (mode 2):
the gate verifies WebAuthn ES256 itself (decided 12.10.2026, §7): `libs/core/src/crypto/webauthn.ts`
(strict DER, `rpId`/origin grammar, `verifyPasskeyEntry`, `webauthnSignature`; `webauthnChallenge`
in `bundle/bundle.ts`; `parseTrust`/`encodeTrust` in `bundle/trust.ts`) and `gates/php`
(`Crypto/Es256.php`, `Bundle/PinnedPasskey.php`, `trust --passkey`). The one exception to "libsodium
only": the ECDSA P-256 verification uses `globalThis.crypto.subtle` (Web Crypto is part of the
platform, not a library) in core and `openssl_verify` in the gate (`ext-openssl`, required only when
mode 2 is pinned and checked at boot, `status` and `check`); hashing stays libsodium/`hash`. The
vectors' signatures come from the test-only RFC 6979 signer `libs/core/scripts/p256-test-signer.ts`.

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
  `sodium_crypto_scalarmult`, `sodium_crypto_generichash`), `hash_equals`, `random_bytes`, `sodium_memzero`.
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

## Help and setup wizard (FR-70–FR-74) — from the first feature on

Ported from lazy-koins (its CLAUDE.md, "Help (F11.21)" and "Setup wizard"); copy the shape.

- **Texts are i18n keys** under `help.*` in both message files (no Markdown files, no
  `innerHTML`): `help.sections.<id>.{title,purpose,where}`, `….steps.<item>`, `….tips.<item>`,
  `help.links.<id>`, `help.faq.items.<id>.{question,answer}`. UI labels quoted in «…» (de-CH) /
  “…” (en); no `{{…}}` in help texts.
- **Structure is code**: `features/help/help-content.ts` — `HELP_SECTIONS` (id, steps, tips,
  "Öffnen" links, items optionally `only: 'cloud' | 'desktop'`), `HELP_FAQ`,
  `HELP_SECTION_FOR_PAGE`, `allHelpKeys()`. Order = "Schritt N von M".
- **Page** `/app/help` (lazy, no API): sticky TOC + search (every word, case/accent-insensitive,
  current language, FAQ included), deep links `#<id>` that scroll, focus and mark; items for the
  other app hidden, the rest badged. Reachable from the sidebar footer above the user menu and
  during the setup wizard ("Einrichtung fortsetzen").
- **Contextual "?"** = `mt-help-link [section]` in page headers and next to every trust-mode /
  hardening-level badge (FR-72). Trust modes and levels are explained with the §2.9 wording only.
- **Setup wizard** (FR-73) as lazy-koins: `/app/setup`, progress per user in the API, a guard that
  routes there until done, steps reuse the settings forms (`embedded`), "Testen" buttons where a
  check exists (test request through the gate, fingerprint comparison).
- **Tests** as lazy-koins: `help-content.spec.ts` (every "Öffnen" path resolves through the real
  router, no orphan `help.*` key, **every quoted UI label in the help is a text the app shows**),
  page service + page specs, `i18n-keys.spec.ts` covers `help.*`.
- **Rule: a feature change updates the help** (FR-74) — new page, renamed button, changed flow →
  the matching section in **both** message files (and `HELP_SECTIONS`) in the same PR. The guide
  describes only what exists.

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
- MySQL/MariaDB (DT-03) later, same pattern — open: `@prisma/adapter-mariadb` needs the `mariadb`
  driver (LGPL-2.1), which the MIT rule does not obviously allow. Ask.
- The desktop's storage choice (DT-03) is a `StoragePort` in core: project folder (default,
  files and Git), SQLite, external DB. **External backends store ciphertext and signed bundles only.**

As built (DT-03):

- **Prisma 7.10** (`prisma-client` generator, CJS) in `apps/api/prisma/{sqlite,postgresql}/`
  (`schema.prisma`, `prisma.config.ts`, `migrations/`). The clients are generated into
  `apps/api/src/generated/` (ignored) by `pnpm db:generate`, which `pnpm install` runs
  (`prepare`). Nothing outside `apps/api/src/persistence/` imports Prisma, `pg` or `node:sqlite`
  (ESLint).
- **SQLite without a native module:** `persistence/database/node-sqlite-adapter.ts` is a Prisma
  driver adapter on Node's built-in `node:sqlite` (works in Node 22 and Electron 42), so there is
  no better-sqlite3 and no ABI pin. PostgreSQL through `@prisma/adapter-pg` on `pg` (pure JS).
- **Migrations:** our own migrator (`persistence/database/migrator.ts`, as lazy-koins) applies the
  bundled migration SQL (`?raw` imports; webpack `asset/source`) in a lock (`BEGIN IMMEDIATE` /
  `pg_advisory_xact_lock`), records them in `_prisma_migrations`, and refuses foreign tables
  (`foreign_tables`), a newer schema (`schema_newer`) and a changed one (`schema_damaged`). Never
  `prisma migrate deploy` at runtime. A new migration: `prisma migrate diff` into both providers'
  folders, hand-written CHECKs/triggers added to both, `MIGRATIONS` in `migrations.ts` extended.
- **Tables:** `history_entry` (append-only by trigger), `sync_project`, `sync_gate`, `sync_secret`,
  `sync_bundle` (no UPDATE); CHECKs refuse anything but sealed secrets and signed bundles.
- **Tests:** `pnpm test:integration` (`apps/api/vitest.integration.config.ts`,
  `*.integration.spec.ts`) runs SQLite for real and PostgreSQL from `MOAT_TEST_POSTGRES_URL`, or
  a throwaway cluster from the local `initdb`/`postgres` (16/17) on a free port
  (`persistence/database/testing/postgres-cluster.ts`).

## Auth

- **Desktop**: `AUTH_MODE=local` exactly as lazy-koins (no login, 127.0.0.1, access token).
- **Cloud** (decided 12.10.2026): **no Firebase, in no form** — no SDK, no service, no token
  format. Built-in accounts (e-mail + password with Argon2id, TOTP, **passkeys/WebAuthn**) plus
  **OIDC** for SSO (SEC-51); SAML later. The API issues and verifies its own sessions/tokens, so
  self-hosting needs no external identity provider.
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

### Security testing (SEC-70–SEC-77, [docs/SECURITY-TESTING.md](docs/SECURITY-TESTING.md))

- **Every API endpoint has an entry in the authorization matrix**
  (`apps/api/src/security/authz-matrix.ts`) in the same PR that adds it — expected answer per
  identity (no token, bad/expired/revoked token, each role, with/without release permission,
  other tenant = 404, wrong token scope, gate credential). The matrix spec runs in `pnpm check`
  and fails on a route without an entry. Never weaken an expectation to make it pass.
- Each new feature checks itself against the OWASP Top 10 / API Top 10 mapping in
  docs/SECURITY-TESTING.md and adds the tests that row names; a new risk updates the mapping
  and the threat model.
- Scanner findings (CodeQL, Semgrep, osv-scanner, gitleaks, Trivy, ZAP, Electronegativity) are
  fixed, not suppressed. An exception needs a justification comment next to it.
- Security fixes and pentest findings always come with a regression test or conformance case.
- `/security-review` before a PR that touches auth, the matrix, crypto, bundles, policy, gates or
  desktop IPC.

## CI

`.github/workflows/ci.yml`: `check` (`pnpm check`, includes the authz matrix), `integration`,
**`gate-php`** (matrix 8.2–8.5, `shivammathur/setup-php`, `pnpm check:gate-php`), `conformance`,
`security` (CodeQL, Semgrep, osv-scanner, gitleaks, Trivy) and `dast` (ZAP baseline on PRs, full
scan nightly against Cloud and gate). The gate lives in
`package.json` — add checks there, never to the YAML alone. Release target: signed gate artifact +
checksums + SBOM (SEC-60, SEC-61), images to ghcr, desktop installers per release (as lazy-koins).

As built: **`.github/workflows/release.yml`**, `workflow_dispatch` on `main` only (input `bump`
patch/minor/major or an exact `version`). `prepare` refuses a commit without a green `ci.yml` run
or with an existing tag/release, then creates a **draft**; `gate-and-cli` and `desktop` (ubuntu,
windows, macos) upload into it with `gh release upload`; `publish` adds `SHA256SUMS.txt` and
`.github/release-notes.md` and publishes (that creates the tag); `discard` deletes the draft on
failure. The version reaches the artifacts through `MOAT_VERSION` (+ `MOAT_COMMIT`):
`gates/php/build/build.php --version --commit`, `apps/cli/build.mjs` (esbuild `define`, printed
by `moat version`; `0.0.0-dev (unknown)` outside a release) and `apps/desktop/scripts/stage.mjs`
(the app manifest, hence the installer names). **Unsigned** (`CSC_IDENTITY_AUTO_DISCOVERY=false`,
no gate release signature, no SBOM) until the signing decision is made. Actions are pinned to the
same SHAs as `ci.yml`; artifacts move through `gh`, not upload/download-artifact. Check workflow
changes with `actionlint` (not yet part of `pnpm check`).

## Secrets (repository)

- Never commit `.env`, keys, key files, signing material or real customer configs. Fixtures use
  generated test keys that are clearly marked (`TEST ONLY` in the file) and never used elsewhere.
- `.githooks/pre-commit` refuses staged `.env*` (except `.env.example`), `*.key`, `*.pem`,
  `*.moatkey` and anything under `private/`. Never `--no-verify`.
- If a secret was ever committed: revoke and rotate first, history scrubbing after.
- Security reports: GitHub private vulnerability reporting ([SECURITY.md](SECURITY.md)).

## Decisions

- **License = MIT** for the whole repo (decided 12.10.2026, instead of the earlier FSL plan).
  New files need no license header; third-party code must be MIT-compatible.
- **Cloud auth without Firebase** (12.10.2026, see Auth).
- **Desktop = Electron** (same stack as lazy-koins, see Desktop).
- **Default trust mode in the Cloud = mode 0 ("Bequem")** with the active recommendation to
  "Signiert" and a mandatory path policy before a secret is bound (12.10.2026, FR-46–FR-48).
- **Passkeys: the gate verifies WebAuthn ES256** (12.10.2026, docs/CRYPTO.md §7).

## Open decisions — ask, don't decide

- **Desktop signing / auto-update** (same open point as lazy-koins).
- **Threat model**: v0.1 in [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) (cite threats as `T-20`);
  its proposals are requirements since v0.4. New features update it (new threat → new `T-…`).

## Conventions carried over from lazy-koins

- Nx monorepo, pnpm, Vitest; `pnpm check` is the gate and CI only calls it.
- Feature folders with one page service per page; every visible string an i18n key; colours only
  in `styles.css`; `libs/ui/**` vendored.
- `.eslint-budget.json` (all 0, may only go down); Nx daemon off; LF line endings.
- The Environment gotchas of lazy-koins (Electron/better-sqlite3 ABI pin, `express.json()` trap,
  pnpm `allowBuilds`, Windows CRLF/PowerShell encoding) apply here too — copy them in here as soon
  as the matching code exists.

## Environment gotchas

- **Electron binary missing** (`Electron failed to install correctly`): its postinstall did not
  run. `node node_modules/electron/install.js` fetches it; `electron` is in `allowBuilds`.
- **Electron as root** (containers, CI): start it with `--no-sandbox`, under `xvfb-run -a`
  when there is no display. Never in a shipped build.
- **`pnpm start:desktop`** stages first (`nx run desktop:stage`: API + web builds, esbuild main
  and preload into `dist/apps/desktop-app`). The packaged app has no native dependencies.
- **Help texts:** «…» marks only UI labels the app shows (a spec checks it); commands and file
  names go in backticks and render as code through `mt-rich-text`.
