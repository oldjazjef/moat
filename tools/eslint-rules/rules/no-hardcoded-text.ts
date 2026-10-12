/**
 * Catches user-facing text typed directly into a template instead of
 * going through ngx-translate, so `apps/web/public/i18n/<lang>.json` stays the single
 * source of truth for every displayed string — the acceptance criterion is explicit that a lint
 * check must fail on a hardcoded string in a template.
 *
 * Deliberately narrow, the same tradeoff `no-hardcoded-design-values` makes: this checks three
 * node kinds only —
 *  - `Text`: a literal text node can never carry a `translate` pipe (there is nothing to bind),
 *    so any letters here are unconditionally hardcoded.
 *  - `TextAttribute`: a plain (unbound) attribute value, e.g. `aria-label="Delete"` instead of
 *    `[attr.aria-label]="'x' | translate"` — flagged unless the attribute is one of
 *    `ALLOWED_ATTRIBUTES`, whose values are technical (CSS classes, component variant/size enums,
 *    routing targets, form-control names, icon names, …), never user-facing prose.
 *  - `BoundText`: an interpolation's own literal fragments (`ast.strings`, the text *outside* any
 *    `{{ }}` expression) — `Hallo {{ name }}` has a literal `"Hallo "` fragment that no pipe can
 *    reach. A template that is entirely one expression (`{{ 'x' | translate }}`) has empty
 *    fragments and is not reported.
 *
 * What this does **not** catch: a bare string literal used *as* the bound expression itself
 * (`{{ 'Some English text' }}`, no pipe) — flagging that needs walking the expression AST and
 * risks false positives on legitimate non-pipe string expressions (an enum value passed to a
 * child component, say). Left for a human to catch in review, same as `no-hardcoded-design-values`
 * leaves Tailwind's non-arbitrary utility classes unchecked.
 */
import { ESLintUtils } from '@typescript-eslint/utils';
import type {
  TmplAstBoundText,
  TmplAstText,
} from '@angular-eslint/bundled-angular-compiler';

export const RULE_NAME = 'no-hardcoded-text';

// Same Unicode letter class approach as @angular-eslint/eslint-plugin-template's own `i18n` rule
// (which this rule deliberately does not depend on, since that rule targets Angular's native
// `i18n` attribute, not ngx-translate) — covers accented Latin (ä, é, …) so German/French text
// is not accidentally treated as "no letters".
const HAS_LETTERS = /[A-Za-zÀ-ÖØ-öø-ÿ]/;

/**
 * Attributes whose static string value is never user-facing prose. Extend this list — not the
 * rule's structure — when a new technical attribute trips a false positive; that has been the
 * actual failure mode encountered while building this rule against the real template corpus.
 */
const ALLOWED_ATTRIBUTES = new Set([
  // Native / Angular-framework attributes (mirrors @angular-eslint/eslint-plugin-template's own
  // `i18n` rule default allow-list for the ones relevant here).
  'class',
  'id',
  'for',
  'name',
  'href',
  'target',
  'style',
  'dir',
  'lang',
  'role',
  'tabindex',
  'colspan',
  'autocomplete',
  // ARIA attributes whose values are element ids or enum tokens, not prose (the prose ones —
  // `aria-label`, `aria-description`, … — stay flagged).
  'aria-labelledby',
  'aria-describedby',
  'aria-controls',
  'aria-autocomplete',
  'aria-live',
  // Native attributes with technical values: a MIME pattern, loading hints.
  'accept',
  'rel',
  'loading',
  'decoding',
  'spellcheck',
  'formArrayName',
  'formControlName',
  'formGroupName',
  'ngProjectAs',
  'routerLink',
  'routerLinkActive',
  'type',
  'value',
  'width',
  'height',
  'viewBox',
  'xmlns',
  // This app's own component API — spartan.ng/helm variant & sizing enums, icon-name inputs, and
  // a handful of native-input attributes whose values are technical, not prose.
  'variant',
  'size',
  'icon',
  'iconSize',
  'kind',
  'inputId',
  'inputmode',
  'collapsible',
  'side',
  'align',
  // spartan tabs' selector-as-value API (`hlmTabsTrigger="files"`) and popover/sheet host
  // element ids — identifiers, never displayed.
  // Angular/spartan enum-valued inputs: toaster placement, router aria-current token.
  'position',
  'ariaCurrentWhenActive',
  'hlmTabsTrigger',
  'hlmTabsContent',
  'tab',
  'buttonId',
  // i18n KEYS handed to components that translate them themselves
  // (`placeholderKey="projects.search"`, `keyPrefix="projects.status."`), and a chip's colour enum.
  'tone',
  'placeholderKey',
  'keyPrefix',
  // Moat's own enum-valued inputs: a help section id (`mt-help-link section="gates"`) and a trust
  // mode (`mt-trust-mode-badge mode="signed"`) — both translated by the component itself.
  'section',
  'mode',
  // SVG presentation attributes — values here are drawing keywords (`currentColor`, `none`, `round`, `middle`, a
  // `url(#id)` fragment reference), never prose a translator would touch.
  'stroke',
  'fill',
  'clip-path',
  'stroke-linejoin',
  'stroke-linecap',
  'stroke-width',
  'text-anchor',
  'font-size',
  'font-weight',
]);

/** `aria-hidden="true"`, `disabled="false"`, … — a boolean literal is never user-facing prose,
 * even though "true"/"false" both happen to satisfy `HAS_LETTERS`. */
function isBooleanLiteral(value: string): boolean {
  return value === 'true' || value === 'false';
}

export const rule = ESLintUtils.RuleCreator(() => __filename)({
  name: RULE_NAME,
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow user-facing text typed directly into a template — route it through ngx-translate and public/i18n/*.json instead.',
    },
    schema: [],
    messages: {
      textNode:
        'Hardcoded text "{{text}}" — use the `translate` pipe with an i18n key instead.',
      textAttribute:
        'Hardcoded text "{{text}}" in the "{{attribute}}" attribute — bind it through the `translate` pipe instead.',
      boundTextLiteral:
        'Hardcoded text "{{text}}" outside the interpolation — move it into the translated string (with an i18n interpolation parameter, if needed).',
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      'Text[value=/[A-Za-zÀ-ÖØ-öø-ÿ]/]'(node: TmplAstText): void {
        const text = node.value.trim();
        if (!HAS_LETTERS.test(text)) return;
        const loc = context.sourceCode.getLocFromIndex(
          node.sourceSpan.start.offset,
        );
        context.report({ loc, messageId: 'textNode', data: { text } });
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TextAttribute's type isn't exported by @angular-eslint/utils under a stable name across versions; matches the loose typing `no-hardcoded-design-values` already accepts for template AST nodes.
      'Element > TextAttribute[value=/[A-Za-zÀ-ÖØ-öø-ÿ]/]'(node: any): void {
        const attributeName: string = node.name;
        if (ALLOWED_ATTRIBUTES.has(attributeName)) return;
        // `data-*` attributes are test and styling hooks, never displayed.
        if (attributeName.startsWith('data-')) return;
        const text = String(node.value).trim();
        if (!HAS_LETTERS.test(text) || isBooleanLiteral(text)) return;
        const loc = context.sourceCode.getLocFromIndex(
          node.sourceSpan.start.offset,
        );
        context.report({
          loc,
          messageId: 'textAttribute',
          data: { text, attribute: attributeName },
        });
      },
      BoundText(node: TmplAstBoundText): void {
        const strings: string[] = (
          node.value as unknown as { ast: { strings: string[] } }
        ).ast.strings;
        const literal = strings.join('').trim();
        if (!HAS_LETTERS.test(literal)) return;
        const loc = context.sourceCode.getLocFromIndex(
          node.sourceSpan.start.offset,
        );
        context.report({
          loc,
          messageId: 'boundTextLiteral',
          data: { text: literal },
        });
      },
    };
  },
});
