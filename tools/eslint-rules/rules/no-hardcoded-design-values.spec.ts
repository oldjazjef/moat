import { RuleTester } from '@typescript-eslint/rule-tester';
import type { RuleTesterConfig } from '@typescript-eslint/rule-tester';
import angularEslint from 'angular-eslint';
import { rule, RULE_NAME } from './no-hardcoded-design-values';

const ruleTester = new RuleTester({
  languageOptions: {
    parser: angularEslint.templateParser,
  },
} as RuleTesterConfig);

ruleTester.run(RULE_NAME, rule, {
  valid: [
    '<div class="bg-primary text-foreground p-4 font-sans">Hello</div>',
    '<span class="font-mono">01:23</span>',
    // The one carve-out: a pointer-tracked percentage is computed layout, not a hardcoded
    // design value, and no static Tailwind class can express it (burndown-chart.html's tooltip).
    '<div [style.left.%]="hoveredLeftPercent()">Hi</div>',
  ],
  invalid: [
    {
      code: '<div data-color="#123456">Hi</div>',
      errors: [{ messageId: 'hexColor' }],
    },
    {
      code: '<div class="bg-[rgb(0,0,0)]">Hi</div>',
      errors: [{ messageId: 'arbitraryColorClass' }],
    },
    {
      code: '<div class="p-[13px]">Hi</div>',
      errors: [{ messageId: 'arbitraryPxClass' }],
    },
    {
      code: '<div class="font-serif">Hi</div>',
      errors: [{ messageId: 'nonTokenFont' }],
    },
    {
      code: '<div style="color:red">Hi</div>',
      errors: [{ messageId: 'styleAttribute' }],
    },
    {
      code: `<div [style.color]="'red'">Hi</div>`,
      errors: [{ messageId: 'styleAttribute' }],
    },
    {
      // Only the `.%` unit is carved out — a pixel binding stays banned, same as a static class.
      code: `<div [style.left.px]="offset()">Hi</div>`,
      errors: [{ messageId: 'styleAttribute' }],
    },
  ],
});
