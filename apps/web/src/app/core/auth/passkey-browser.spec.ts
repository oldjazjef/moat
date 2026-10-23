import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { apiErrorMethods } from './api-error';
import {
  fromBase64Url,
  PasskeyBrowser,
  PasskeyBrowserError,
  toBase64Url,
} from './passkey-browser';

describe('base64url', () => {
  it('round-trips bytes without padding or the standard alphabet', () => {
    for (const length of [0, 1, 2, 3, 31, 32, 65]) {
      const bytes = new Uint8Array(length).map((_, i) => (i * 37 + 250) % 256);
      const text = toBase64Url(bytes);
      expect(text).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(Array.from(fromBase64Url(text))).toEqual(Array.from(bytes));
    }
  });
});

describe('PasskeyBrowser', () => {
  const browser = () => TestBed.inject(PasskeyBrowser);

  it('says unsupported when the browser has no WebAuthn', async () => {
    const instance = browser();
    vi.spyOn(instance, 'supported', 'get').mockReturnValue(false);
    await expect(
      instance.get({
        challenge: 'AA',
        rpId: 'x.ch',
        credentialIds: [],
        timeoutMs: 1,
      }),
    ).rejects.toMatchObject({ problem: 'unsupported' });
  });

  it('turns a closed prompt into "cancelled" and anything else into "failed"', async () => {
    const instance = browser();
    vi.spyOn(instance, 'supported', 'get').mockReturnValue(true);
    const get = vi.fn();
    Object.defineProperty(navigator, 'credentials', {
      configurable: true,
      value: { get, create: vi.fn() },
    });
    const call = () =>
      instance.get({
        challenge: 'AA',
        rpId: 'x.ch',
        credentialIds: ['AA'],
        timeoutMs: 1,
      });
    get.mockRejectedValueOnce(
      Object.assign(new Error('x'), { name: 'NotAllowedError' }),
    );
    await expect(call()).rejects.toMatchObject({ problem: 'cancelled' });
    get.mockRejectedValueOnce(new Error('boom'));
    await expect(call()).rejects.toBeInstanceOf(PasskeyBrowserError);
    get.mockResolvedValueOnce(null);
    await expect(call()).rejects.toMatchObject({ problem: 'failed' });
    // Asked for user verification and a given rp, never for attestation of the device.
    const options = (get.mock.calls[0]?.[0] as CredentialRequestOptions)
      .publicKey;
    expect(options).toMatchObject({
      rpId: 'x.ch',
      userVerification: 'required',
    });
  });
});

describe('apiErrorMethods', () => {
  it('reads the named methods and ignores anything else', () => {
    const failure = (body: unknown) =>
      new HttpErrorResponse({ status: 401, error: body });
    expect(
      apiErrorMethods(
        failure({ error: 'mfa_required', methods: ['totp', 'passkey'] }),
      ),
    ).toEqual(['totp', 'passkey']);
    expect(apiErrorMethods(failure({ methods: ['totp', 'admin', 3] }))).toEqual(
      ['totp'],
    );
    expect(apiErrorMethods(failure({ methods: 'totp' }))).toEqual([]);
    expect(apiErrorMethods(failure(null))).toEqual([]);
    expect(apiErrorMethods(new Error('x'))).toEqual([]);
  });
});
