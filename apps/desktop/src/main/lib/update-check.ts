/**
 * Whether a newer Moat release exists (decided 30.10.2026: check and show, never download or
 * install — the app is unsigned, and an update installed on its own would make the GitHub
 * account the only thing between an attacker and every desktop). Pure: main.ts fetches the
 * answer of GitHub's "latest release" and hands its text here.
 */

/** The repository the releases come from (`.github/workflows/release.yml`). */
export const RELEASE_REPOSITORY = 'oldjazjef/moat';
export const LATEST_RELEASE_URL = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`;
/** At most this much of GitHub's answer is read. */
export const MAX_RELEASE_ANSWER_BYTES = 256 * 1024;

const VERSION = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;
const TAG = /^v(\d{1,6}\.\d{1,6}\.\d{1,6})$/;

export type UpdateCheck =
  | { readonly status: 'current'; readonly current: string }
  | {
      readonly status: 'available';
      readonly current: string;
      readonly latest: string;
    }
  /** A development build (0.0.0) has nothing to compare. */
  | { readonly status: 'development'; readonly current: string }
  | { readonly status: 'failed'; readonly current: string };

/** The release's version from GitHub's answer; null for anything but a plain `vX.Y.Z` release. */
export function latestVersionOf(text: string): string | null {
  if (text.length > MAX_RELEASE_ANSWER_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const release = value as Record<string, unknown>;
  if (release['draft'] === true || release['prerelease'] === true) return null;
  const tag = release['tag_name'];
  if (typeof tag !== 'string') return null;
  return TAG.exec(tag)?.[1] ?? null;
}

/** -1, 0 or 1; null when one of them is not `X.Y.Z`. */
export function compareVersions(a: string, b: string): number | null {
  const x = VERSION.exec(a);
  const y = VERSION.exec(b);
  if (x === null || y === null) return null;
  for (let i = 1; i <= 3; i += 1) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function updateCheckOf(
  current: string,
  answer: string | null,
): UpdateCheck {
  if (current === '0.0.0' || VERSION.exec(current) === null)
    return { status: 'development', current };
  const latest = answer === null ? null : latestVersionOf(answer);
  if (latest === null) return { status: 'failed', current };
  return (compareVersions(latest, current) ?? 0) > 0
    ? { status: 'available', current, latest }
    : { status: 'current', current };
}

/**
 * The release page of a version, built here from the checked version alone — never an address
 * from GitHub's answer, so the answer cannot send the person anywhere else.
 */
export function releasePageOf(version: string): string | null {
  return VERSION.test(version)
    ? `https://github.com/${RELEASE_REPOSITORY}/releases/tag/v${version}`
    : null;
}
