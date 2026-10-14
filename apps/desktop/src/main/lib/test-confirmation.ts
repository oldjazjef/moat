/**
 * «Testen» in the setup wizard (FR-73) and «Von aussen prüfen» (DT-07), T-59: before the first request to an address, the
 * main process asks in a dialog of its own, naming the host — the page may be compromised and the
 * test request is its only way out to the internet. A yes is remembered per origin until the app
 * quits; a no is not, so the next test asks again.
 */
export function gateTestConfirmation(
  show: (origin: string, host: string) => Promise<boolean>,
): (target: string) => Promise<boolean> {
  const confirmed = new Set<string>();
  return async (target) => {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      return false;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    if (confirmed.has(url.origin)) return true;
    if (!(await show(url.origin, url.host))) return false;
    confirmed.add(url.origin);
    return true;
  };
}
