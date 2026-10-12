import {
  RULE_NAME as noHardcodedDesignValuesName,
  rule as noHardcodedDesignValues,
} from './rules/no-hardcoded-design-values';
import {
  RULE_NAME as noHardcodedTextName,
  rule as noHardcodedText,
} from './rules/no-hardcoded-text';

/**
 * Workspace lint rules, loaded by @nx/eslint-plugin as `@nx/workspace-<name>` (copied from
 * lazy-koins). New rules: `nx g @nx/eslint:workspace-rule <name>`.
 */
module.exports = {
  rules: {
    [noHardcodedDesignValuesName]: noHardcodedDesignValues,
    [noHardcodedTextName]: noHardcodedText,
  },
};
