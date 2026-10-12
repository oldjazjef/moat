---
name: add-ui-component
description: Add a spartan.ng helm UI component (dialog, select, sheet, tooltip, ...) to libs/ui via the spartan CLI generator. Use when a page needs a UI primitive that is not yet in libs/ui.
---

# Add a spartan component

```bash
ls libs/ui/                                              # already there?
npx nx g @spartan-ng/cli:ui --name=<component> --no-interactive
npx nx run-many -t lint --fix                            # peerDependencies for the new lib
```

- It creates `libs/ui/<component>/` as an Nx library imported as `@moat/ui/<component>`, adds
  the path to `tsconfig.base.json`, and runs `pnpm install`.
- `components.json` at the root configures the generator; if it prompts, that file is missing.
- If the generator fails with "does not export the ignore checkers", `@nx/devkit` drifted from
  `nx` — keep the `overrides` in `pnpm-workspace.yaml` in step with the `nx` version.
- `libs/ui/**` is vendored: never restyle or refactor it, compose around it. Prettier skips it
  and `.eslint-budget.json` leaves it out on purpose (lint errors there still fail).
- If the generator rewrites `libs/ui/utils/eslint.config.mjs`, re-add its
  `no-non-null-assertion: off` block (see the comment there) or `pnpm lint` shows 17 warnings.
- Import the `Hlm<Component>Imports` array into the page's `imports`.
