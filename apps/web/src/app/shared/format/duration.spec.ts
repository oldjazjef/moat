import { describe, expect, it } from 'vitest';
import { durationParts, sizeParts } from './duration';

describe('durationParts', () => {
  it('uses the largest whole unit', () => {
    expect(durationParts(86_400)).toEqual({ value: 1, unitKey: 'units.days' });
    expect(durationParts(7_200)).toEqual({ value: 2, unitKey: 'units.hours' });
    expect(durationParts(600)).toEqual({ value: 10, unitKey: 'units.minutes' });
    expect(durationParts(90)).toEqual({ value: 90, unitKey: 'units.seconds' });
  });
});

describe('sizeParts', () => {
  it('uses KiB and MiB only when they divide evenly', () => {
    expect(sizeParts(4_096)).toEqual({ value: 4, unitKey: 'units.kib' });
    expect(sizeParts(10_485_760)).toEqual({ value: 10, unitKey: 'units.mib' });
    expect(sizeParts(1_500)).toEqual({ value: 1_500, unitKey: 'units.bytes' });
  });
});
