import { randomBytes } from 'node:crypto';

/** The time, injectable so that expiry and rate-limit windows can be tested. */
export abstract class Clock {
  abstract now(): Date;
}

export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}

/** ISO-8601 UTC with milliseconds and `Z`: the one timestamp format of the database (CHECKs). */
export function iso(date: Date): string {
  return date.toISOString();
}

/** 128 random bits as 22 characters of base64url: the id of an account, organisation, … */
export function newId(): string {
  return randomBytes(16).toString('base64url');
}

export const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
