/**
 * Catches hardcoded colors/spacing/fonts in Angular templates so the design-token
 * source of truth stays `apps/web/src/styles.css`, not values sprinkled through markup.
 */
import { ESLintUtils } from '@typescript-eslint/utils';

export const RULE_NAME = 'no-hardcoded-design-values';

const HEX_COLOR = /#[0-9a-fA-F]{3,8}\b/g;
const ARBITRARY_COLOR_CLASS = /-\[(#|rgb\(|hsl\()/g;
const ARBITRARY_PX_CLASS = /-\[\d+(?:\.\d+)?px\]/g;
const NON_TOKEN_FONT_CLASS = /\bfont-(serif|\[[^\]]*\])\b/g;
// A `[style.prop.%]` binding is excluded: a percentage is a runtime-computed layout position
// (e.g. a chart tooltip tracking a pointer position that no static Tailwind class can express), not a hardcoded design value this rule polices — everything else, including a
// bare `style=` and any other `[style.prop]`/`[style.prop.px]` binding, stays banned.
const STYLE_ATTRIBUTE = /\s(?:\[style(?:\.(?!\S*\.%\])\S+)?\]|style)=/g;

const CHECKS: { pattern: RegExp; messageId: string }[] = [
  { pattern: HEX_COLOR, messageId: 'hexColor' },
  { pattern: ARBITRARY_COLOR_CLASS, messageId: 'arbitraryColorClass' },
  { pattern: ARBITRARY_PX_CLASS, messageId: 'arbitraryPxClass' },
  { pattern: NON_TOKEN_FONT_CLASS, messageId: 'nonTokenFont' },
  { pattern: STYLE_ATTRIBUTE, messageId: 'styleAttribute' },
];

export const rule = ESLintUtils.RuleCreator(() => __filename)({
  name: RULE_NAME,
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow hardcoded colors, pixel spacing, foreign fonts and inline styles in templates — use the design tokens in styles.css instead.',
    },
    schema: [],
    messages: {
      hexColor:
        'Hardcoded hex color {{match}} — use a semantic token class (e.g. bg-primary) instead.',
      arbitraryColorClass:
        'Arbitrary color value "{{match}}" — use a semantic token class instead.',
      arbitraryPxClass:
        'Arbitrary pixel spacing "{{match}}" — use the Tailwind spacing scale instead.',
      nonTokenFont:
        'Font utility "{{match}}" is not one of the project fonts (font-sans, font-mono).',
      styleAttribute:
        'Inline style attribute — use token utility classes instead.',
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      Program(node): void {
        const sourceCode = context.sourceCode;
        const text = sourceCode.getText();

        for (const { pattern, messageId } of CHECKS) {
          pattern.lastIndex = 0;
          let match: RegExpExecArray | null;
          while ((match = pattern.exec(text)) !== null) {
            const loc = sourceCode.getLocFromIndex(match.index);
            context.report({
              loc,
              node,
              messageId,
              data: { match: match[0].trim() },
            });
          }
        }
      },
    };
  },
});
