---
name: add-recipe
description: Add a recipe (ready-made moat.yaml template such as "HubSpot newsletter signup" or "OpenAI chat with daily budget") for a SaaS API. Use when asked to support a new API/provider out of the box or to add a template for a common use case (FR-43).
---

# Add a recipe

A recipe is **data** (FR-43): a parameterised `moat.yaml` with a domain endpoint (FR-11), not
code and not a 1:1 passthrough of the provider's API.

1. **Look first**: `ls recipes/` and `libs/core/src/recipes/`; copy the closest one.

2. **Design the endpoint for the website, not the provider**: e.g. `POST /newsletter` with
   `{ email, firstName? }`, mapped to the provider call(s). Request schema strict and minimal
   (FR-13), response filtered to what the page needs (FR-14).

3. **Least privilege by default**:
   - one upstream host, HTTPS, exact paths, the minimal method set;
   - the secret bound to that upstream only, referenced by name (never a value in the file);
   - client protection on (origin binding at least, Turnstile/honeypot for public forms);
   - rate limit and, for AI providers, a daily **budget** (FR-31) with a conservative default;
   - note the provider scopes the token needs — the smallest that works.

4. **Write it** as `recipes/<provider>-<use-case>.moat.yaml` with the schema modeline, quoted
   strings, durations with units, plus its metadata in `libs/core/src/recipes/` (title and
   description i18n keys, parameters with Zod schemas).

5. **Test**: the recipe validates against the schema; its bundle builds; an HTTP conformance-style
   test against a fake upstream (never the real provider) shows the mapped call, the injected
   secret on the right host only, and the rejected cases (extra fields, wrong origin, over limit).

6. `pnpm check`, and `pnpm check:gate-php` if the gate needed anything new (then use the
   `change-config-schema` skill first).
