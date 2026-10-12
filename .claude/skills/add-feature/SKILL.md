---
name: add-feature
description: Add a routed feature or page to apps/web (the Moat Cloud dashboard, also shown in Moat Desktop) following this repo's conventions - lazy route, OnPush standalone page + page service, httpResource reads, ActionRunner mutations, translated strings, Zod-validated forms. Use when asked to add a page, screen, feature or route to the dashboard.
---

# Add a feature to apps/web

1. **Look first.** `ls apps/web/src/app/features/` (does it belong in an existing feature?),
   `ls libs/ui/` (generate missing components with the `add-ui-component` skill), and read the
   closest sibling page.

2. **Layout** — never nest a routed feature inside another:

   ```
   features/<feature>/
     <feature>.routes.ts          # default-exported Routes, pages via loadComponent
     pages/<page>/<page>.ts|.html|.service.ts|.spec.ts
     components/<c>/<c>.ts + index.ts   # only when >1 page uses it
   ```

   Register it in `app.routes.ts` with `loadChildren`.

3. **Page = component + page service.** Reads with `httpResource<T>(() => apiUrl('/…'))`,
   mutations with `defineAction` + `ActionRunner.run(...)`, messages are i18n keys. Detail-page
   services are provided by the page, list/form services are root.

4. **Rules**: standalone, `OnPush`, `inject()`, `input()`/`output()`, `@if`/`@for`, selector
   prefix `mt-`. Route params bind to inputs with **no default**.

5. **Security in the UI** (CLAUDE.md, Security rules):
   - Never send a plaintext secret to the API. Secret inputs seal through `@moat/core` in the
     browser before the request, and the page says that browser sealing depends on the served
     code (SEC-37) and points to the CLI / Desktop.
   - Show trust mode and hardening level as they are in force (§1.5) — no optimistic labels.
   - Signing/releasing is its own permission (SEC-52): hide and disable, but the API decides.

6. **Forms**: typed reactive forms + `zodValidator(Schema)`; reuse the core config schema for
   anything that ends up in `moat.yaml` — never a second hand-written copy.

7. **Text**: every string in `public/i18n/de-CH.json` + `en.json`; `pnpm test` fails on a missing
   key. **Styling**: semantic token classes only; new colours in `src/styles.css` (both themes).

8. **Help** (FR-70–FR-74, CLAUDE.md "Help and setup wizard"): add or update the section in
   `features/help/help-content.ts` and its `help.*` texts in **both** message files, add an
   `mt-help-link` to the page header, and quote UI labels exactly as the app shows them
   (`help-content.spec.ts` checks it). The help describes only what exists.

9. **Test** the page service with `HttpTestingController`, then `pnpm check`. For anything
   visible, run the app and look at it — in the browser and in the desktop shell.
