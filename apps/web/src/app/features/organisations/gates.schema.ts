import { z } from 'zod';

/** What the API takes for a gate (SEC-32): the bounds are the API's, the text is the page's. */
export const gateSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/, 'gateName'),
  gateId: z.string().regex(/^[A-Za-z0-9_-]{22}$/, 'gateId'),
  boxKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'boxKey'),
  fingerprint: z.string().trim().min(1, 'fingerprint').max(128),
  /** Empty: Moat Cloud signs (Bequem). A key: the customer signs (Signiert). */
  signerKey: z
    .string()
    .trim()
    .refine(
      (value) => value === '' || /^[A-Za-z0-9_-]{43}$/.test(value),
      'signerKey',
    ),
});
