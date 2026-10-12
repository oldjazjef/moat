---
name: change-config-schema
description: Add or change a field, route option, upstream auth type or transformation in the moat.yaml config schema - Zod schema in libs/core, generated JSON Schema, bundle, conformance cases and every gate. Use whenever moat.yaml, the bundle format or what a gate enforces changes.
---

# Change the moat.yaml schema

The config is data, never code (SEC-20, SEC-23). A schema change touches every implementation —
do all steps in one PR.

1. **Check the security rules first** (CLAUDE.md). Would the field let the Cloud widen the local
   policy, add an upstream, move a secret, run logic or weaken trust? Then it does not go in the
   bundle — it belongs in the local policy (installed on the gate) or not at all. Ask if unsure.

2. **Zod schema** in `libs/core/src/config/`: strict objects, closed enums, explicit limits
   (lengths, counts, ranges). Strings that look like other types are strings. A new
   transformation is a new member of the closed list of operations, with no free-form expression.

3. **Policy intersection** in `libs/core/src/policy/` if the field can be capped by the local
   policy (methods, sizes, hosts, limits). The effective value is the stricter one.

4. `pnpm schema` → commit `schema/moat.schema.json`. Breaking change? Bump `version`, add a
   migration in core and a test that migrates every example in `recipes/`.

5. **Conformance first**: add cases to `conformance/vectors/` and/or `conformance/http/` —
   accepted value, each rejected value (wrong type, out of range, unknown sibling field), and
   the attacker case the field could enable.

6. Implement in `libs/core` (bundle build + validation), then in **every gate target**
   (`gates/php/` first). Unknown fields are rejected by gates too — an old gate must refuse a
   bundle it does not understand rather than ignore part of it (fail closed, SEC-46).

7. Update the dashboard forms (they reuse the Zod schema), the recipes that benefit, and
   ANFORDERUNGEN.md if a requirement changed.

8. `pnpm check`, `pnpm check:gate-php`, `pnpm conformance`, then `/security-review`.
