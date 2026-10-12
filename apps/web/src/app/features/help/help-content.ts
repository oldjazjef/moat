/**
 * The in-app guide (Hilfe, FR-70–FR-74), as lazy-koins: its STRUCTURE lives here, its TEXTS in the
 * message files under `help.*` (`public/i18n/de-CH.json` + `en.json`, same keys — the i18n specs
 * keep them in step). A section is a numbered step of the guide; its texts are
 * `help.sections.<id>.{title,purpose,where}`, `….steps.<item>` and `….tips.<item>` in the order
 * listed here. The guide describes only what exists (FR-74): change the app → change the help.
 */

/** Which app a step or link applies to. */
export type HelpMode = 'cloud' | 'desktop';

export interface HelpItem {
  /** The key below `steps.` / `tips.` of its section. */
  readonly id: string;
  /** Only shown in that app (and then marked "Nur Cloud" / "Nur Desktop"). */
  readonly only?: HelpMode;
}

/** An "Öffnen" button: a route of the app (checked against the router by `help-content.spec.ts`). */
export interface HelpLink {
  /** Label `help.links.<id>`. */
  readonly id: string;
  readonly path: string;
  readonly only?: HelpMode;
}

export const HELP_SECTION_IDS = [
  'project',
  'gate',
  'trust',
  'secrets',
  'routes',
  'limits',
  'release',
  'environments',
  'privacy',
] as const;
export type HelpSectionId = (typeof HELP_SECTION_IDS)[number];

export interface HelpSection {
  readonly id: HelpSectionId;
  readonly steps: readonly HelpItem[];
  readonly tips: readonly HelpItem[];
  readonly links: readonly HelpLink[];
}

const items = (...ids: readonly (string | HelpItem)[]): readonly HelpItem[] =>
  ids.map((id) => (typeof id === 'string' ? { id } : id));

/** Gates and routes live inside a project, so every step opens the project list. */
const PROJECTS: HelpLink = { id: 'projects', path: '/app/projects' };

/** The guide, in the order of the work (FR-70): "Schritt N von M" is the position here. */
export const HELP_SECTIONS: readonly HelpSection[] = [
  {
    id: 'project',
    steps: items('cli', 'folder', { id: 'add', only: 'desktop' }, 'check'),
    tips: items('git', 'reload', 'remove'),
    links: [PROJECTS],
  },
  {
    id: 'gate',
    steps: items('upload', 'install', 'add', 'compare', 'check'),
    tips: items('mismatch', 'php'),
    links: [PROJECTS],
  },
  {
    id: 'trust',
    steps: items('keygen', 'trust', 'badge'),
    tips: items('passphrase', { id: 'desktopOnly', only: 'desktop' }),
    links: [PROJECTS],
  },
  {
    id: 'secrets',
    steps: items('upstream', 'seal', 'check'),
    tips: items('never', 'rotate'),
    links: [PROJECTS],
  },
  {
    id: 'routes',
    steps: items('write', 'recipe', 'origins', 'bundle', 'check'),
    tips: items('exact', 'quote'),
    links: [PROJECTS],
  },
  {
    id: 'limits',
    steps: items('route', 'policy', 'answer'),
    tips: items('proxy'),
    links: [PROJECTS],
  },
  {
    id: 'release',
    steps: items('build', 'deploy', 'accept'),
    tips: items('rollback', 'policy'),
    links: [PROJECTS],
  },
  {
    id: 'environments',
    steps: items('define', 'lock', 'build', 'check'),
    tips: items('unlock', 'saved', 'one', 'answer'),
    links: [PROJECTS],
  },
  {
    id: 'privacy',
    steps: items('local', 'ciphertext', 'noAdmin'),
    tips: items('folder'),
    links: [PROJECTS],
  },
];

/** Frequent questions (`help.faq.items.<id>.{question,answer}`), under the steps. */
export const HELP_FAQ = [
  'noProject',
  'invalidConfig',
  'missingSecret',
  'fingerprint',
  'lockPending',
] as const;
export type HelpFaqId = (typeof HELP_FAQ)[number];

/** The anchor of the FAQ block (`/app/help#faq`). */
export const HELP_FAQ_ANCHOR = 'faq';

export const helpKeys = {
  title: (section: HelpSectionId) => `help.sections.${section}.title`,
  purpose: (section: HelpSectionId) => `help.sections.${section}.purpose`,
  where: (section: HelpSectionId) => `help.sections.${section}.where`,
  step: (section: HelpSectionId, item: string) =>
    `help.sections.${section}.steps.${item}`,
  tip: (section: HelpSectionId, item: string) =>
    `help.sections.${section}.tips.${item}`,
  link: (link: string) => `help.links.${link}`,
  question: (faq: HelpFaqId) => `help.faq.items.${faq}.question`,
  answer: (faq: HelpFaqId) => `help.faq.items.${faq}.answer`,
  only: (mode: HelpMode) => `help.only.${mode}`,
};

/** Every key of a section (for the search and the i18n key check). */
export function sectionKeys(section: {
  readonly id: HelpSectionId;
  readonly steps: readonly HelpItem[];
  readonly tips: readonly HelpItem[];
}): string[] {
  return [
    helpKeys.title(section.id),
    helpKeys.purpose(section.id),
    helpKeys.where(section.id),
    ...section.steps.map((item) => helpKeys.step(section.id, item.id)),
    ...section.tips.map((item) => helpKeys.tip(section.id, item.id)),
  ];
}

/** Every key the guide builds at runtime (listed in `i18n-keys.spec.ts`). */
export function allHelpKeys(): string[] {
  return [
    ...HELP_SECTIONS.flatMap((section) => [
      ...sectionKeys(section),
      ...section.links.map((link) => helpKeys.link(link.id)),
    ]),
    ...HELP_FAQ.flatMap((faq) => [
      helpKeys.question(faq),
      helpKeys.answer(faq),
    ]),
    helpKeys.only('cloud'),
    helpKeys.only('desktop'),
  ];
}
