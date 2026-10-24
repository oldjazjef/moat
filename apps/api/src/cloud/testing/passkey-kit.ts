import { PasskeyService, PasskeyRp } from '../auth/application/passkey-service';
import { relyingPartyOf } from '../auth/domain/passkey';
import { InMemoryOidc, InMemoryPasskeys, type FixedClock } from './in-memory';

/** The origin the passkeys of the specs belong to (a secure context). */
export const PASSKEY_ORIGIN = 'https://moat.example.ch';

/** The passkey store and service of a spec, for the relying party of `origin`. */
export function passkeyKit(clock: FixedClock, origin = PASSKEY_ORIGIN) {
  const passkeys = new InMemoryPasskeys();
  const oidc = new InMemoryOidc();
  const rp = relyingPartyOf(origin);
  return {
    passkeys,
    oidc,
    rp,
    service: new PasskeyService(passkeys, new PasskeyRp(rp), clock),
  };
}
