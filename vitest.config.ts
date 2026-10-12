import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      '**/vitest.config.{mjs,js,ts,mts}',
      '!vitest.config.{mjs,js,ts,mts}',
      // Agent worktrees can sit under `.claude/worktrees/` — each has its own vitest.config.ts.
      '!.claude/worktrees/**',
      '!**/node_modules/**',
      '!gates/php/vendor/**',
    ],
  },
});
