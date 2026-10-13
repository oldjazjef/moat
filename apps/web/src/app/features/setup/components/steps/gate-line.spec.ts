import { parseGateAddLine } from './gate-line';

describe('parseGateAddLine', () => {
  it('takes gate id and box key from the line the gate printed', () => {
    expect(
      parseGateAddLine(
        '  moat gate add <name> --gate-id=AbC_-0123456789abcdefgh --box-key=-xYz_09',
      ),
    ).toEqual({ gateId: 'AbC_-0123456789abcdefgh', boxKey: '-xYz_09' });
  });

  it('ignores anything that is not that line', () => {
    expect(parseGateAddLine('AbC_-0123456789abcdefgh')).toBeNull();
    expect(parseGateAddLine('--gate-id=abc')).toBeNull();
  });
});
