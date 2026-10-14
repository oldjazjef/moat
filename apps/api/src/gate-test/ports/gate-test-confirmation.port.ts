/**
 * Asks the person, outside the page, whether «Testen» may send to this address (T-59): the page
 * could be compromised (renderer XSS), and the test request is the one way out of `connect-src
 * 'self'`. Moat Desktop answers with a main-process dialog naming the host and remembers a yes
 * per origin for the session; anything that registered no confirmation refuses.
 */
export abstract class GateTestConfirmationPort {
  abstract confirm(target: URL, locale: string): Promise<boolean>;
}

/** The desktop's main process registers `ask` (desktop.ts); until then every test is refused. */
export class MainProcessConfirmation extends GateTestConfirmationPort {
  private ask: ((target: string, locale: string) => Promise<boolean>) | null =
    null;

  register(ask: (target: string, locale: string) => Promise<boolean>): void {
    this.ask = ask;
  }

  async confirm(target: URL, locale: string): Promise<boolean> {
    if (this.ask === null) return false;
    try {
      return (await this.ask(target.href, locale)) === true;
    } catch {
      return false;
    }
  }
}
