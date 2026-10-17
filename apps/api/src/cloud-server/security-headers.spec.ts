import { describe, expect, it } from 'vitest';
import { cloudHelmetOptions, contentSecurityPolicy } from './security-headers';

describe('security headers', () => {
  it('the CSP allows only own files, no inline script, no framing', () => {
    const csp = contentSecurityPolicy(false);
    expect(csp).toContain("script-src 'self'");
    // Only WebAssembly may be compiled (the browser seals a secret with libsodium); no eval, no inline.
    expect(csp).toContain("'wasm-unsafe-eval'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-(inline|eval)'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('upgrade-insecure-requests');
    expect(contentSecurityPolicy(true)).toContain('upgrade-insecure-requests');
  });

  it('HSTS only with a Secure cookie', () => {
    expect(cloudHelmetOptions(true).strictTransportSecurity).toMatchObject({
      maxAge: 31_536_000,
    });
    expect(cloudHelmetOptions(false).strictTransportSecurity).toBe(false);
  });
});
