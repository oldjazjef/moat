import { z } from 'zod';

/**
 * What the forms check before anything is sent — the same bounds as the API (`PASSWORD_MIN` 12,
 * `PASSWORD_MAX` 256, the address shape of `normaliseEmail`). Only a first, friendly check: the
 * API decides, and its answer is shown as it comes.
 */
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;

export const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .regex(
    /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i,
  );

/** Counted in characters, as the API counts them. */
export const newPasswordSchema = z
  .string()
  .refine((value) => [...value.normalize('NFKC')].length >= PASSWORD_MIN)
  .refine((value) => [...value.normalize('NFKC')].length <= PASSWORD_MAX);

/** An existing password is only checked for being there (the API's rules may have changed). */
export const currentPasswordSchema = z.string().min(1).max(1024);

/** A TOTP code (6 digits, spaces allowed) or a recovery code. */
export const codeSchema = z.string().trim().min(1).max(64);

export const nameSchema = z.string().trim().min(1).max(400);
