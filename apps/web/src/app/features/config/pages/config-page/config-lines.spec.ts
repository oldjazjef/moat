import { gateLines, lineOffset } from './config-lines';

const YAML = `version: 1
gates:
  # the shop
  site:
    environment: production
  api:
    environment: staging
    enabled: false

routes: {}
`;

describe('gateLines', () => {
  it("finds a gate's entry under gates:", () => {
    expect(gateLines(YAML, 'site')).toEqual({ from: 4, to: 5 });
    expect(gateLines(YAML, 'api')).toEqual({ from: 6, to: 8 });
  });

  it('answers null without the gate or without gates:', () => {
    expect(gateLines(YAML, 'shop')).toBeNull();
    expect(gateLines('version: 1\n', 'site')).toBeNull();
  });

  it('never takes a nested key for a gate', () => {
    expect(gateLines(YAML, 'environment')).toBeNull();
  });

  it('reads the last entry to the end of the file', () => {
    expect(gateLines('gates:\n  www:\n    enabled: true\n', 'www')).toEqual({
      from: 2,
      to: 3,
    });
  });
});

describe('lineOffset', () => {
  it('counts lines from 1', () => {
    expect(lineOffset('a\nbb\nc', 1)).toBe(0);
    expect(lineOffset('a\nbb\nc', 3)).toBe(5);
    expect(lineOffset('a', 9)).toBe(1);
  });
});
