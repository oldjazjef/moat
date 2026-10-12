import { RuleTester } from '@typescript-eslint/rule-tester';
import type { RuleTesterConfig } from '@typescript-eslint/rule-tester';
import angularEslint from 'angular-eslint';
import { rule, RULE_NAME } from './no-hardcoded-text';

const ruleTester = new RuleTester({
  languageOptions: {
    parser: angularEslint.templateParser,
  },
} as RuleTesterConfig);

ruleTester.run(RULE_NAME, rule, {
  valid: [
    // Translated content, the normal case.
    `<p>{{ 'groups.title' | translate }}</p>`,
    // An interpolation whose whole result is piped to translate, including a ternary picking
    // between two keys — the pipe wraps the entire expression, so nothing here is untranslated.
    `<h3>{{ (editing() ? 'a.b' : 'a.c') | translate }}</h3>`,
    // A dynamic expression with no literal text around it.
    `<span>{{ selectedYear() }}</span>`,
    // Technical attribute values — never user-facing prose.
    `<button hlmBtn variant="outline" size="icon-sm" type="button"></button>`,
    `<div collapsible="icon"></div>`,
    `<mt-help-link section="gates" />`,
    `<mt-trust-mode-badge mode="signed" />`,
    `<p data-config-status="missing"></p>`,
    `<hlm-popover-content side="right" align="start"></hlm-popover-content>`,
    `<button hlmTabsTrigger="files" type="button"></button>`,
    `<span aria-hidden="true"></span>`,
    `<a routerLink="/app/projects" class="text-sm"></a>`,
    // ARIA id references and enum tokens, MIME patterns, loading hints.
    `<input aria-describedby="hint" aria-controls="list" aria-autocomplete="list" accept="image/*" />`,
    `<img loading="lazy" decoding="async" />`,
    `<div aria-live="polite"></div>`,
    `<textarea spellcheck="false"></textarea>`,
    `<a rel="noopener nofollow" target="_blank"></a>`,
    `<mt-route-select inputId="route-name" />`,
    // Bound attributes are out of this rule's scope entirely (checked, if at all, by other means).
    `<span [attr.aria-label]="'x' | translate"></span>`,
    // SVG presentation attributes — drawing keywords, not prose.
    `<svg><path stroke="currentColor" fill="none" clip-path="url(#a)" stroke-linejoin="round" stroke-linecap="round" stroke-width="2" text-anchor="middle" font-size="12" font-weight="600" /></svg>`,
    // Whitespace-only text nodes (template formatting) carry no letters.
    `<div>\n  <span>{{ x }}</span>\n</div>`,
  ],
  invalid: [
    {
      code: '<p>Hello</p>',
      errors: [{ messageId: 'textNode' }],
    },
    {
      code: '<button aria-label="Delete"></button>',
      errors: [{ messageId: 'textAttribute' }],
    },
    {
      code: `<input placeholder="Enter your name" />`,
      errors: [{ messageId: 'textAttribute' }],
    },
    {
      // A literal fragment sitting next to a dynamic binding — the binding may well be
      // translated, but "Hello " itself never goes through the pipe.
      code: '<p>Hello {{ name() }}</p>',
      errors: [{ messageId: 'boundTextLiteral' }],
    },
  ],
});
