import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  answersLikeGate,
  classifyProbes,
  DATA_FILES,
  inspectProbe,
  probePaths,
  type GateProbeAnswer,
  type ProbeAnswer,
} from './external-probe';

const bytes = (text: string) => new TextEncoder().encode(text);
const GATE: GateProbeAnswer = { status: 404, body: '{"error":"not_found"}\n' };
const DENIED: ProbeAnswer = inspectProbe(404, bytes('Not Found'));
const denied = (): ProbeAnswer[] => [...DATA_FILES, 'index'].map(() => DENIED);

describe('the check from outside in Moat Desktop (DT-07, SEC-49)', () => {
  it('finds a data file whose source comes back, from its bytes', () => {
    const files = denied();
    files[0] = inspectProbe(
      200,
      bytes('<?php http_response_code(404); exit; __halt_compiler();{"…"}'),
    );
    expect(files[0]).toEqual({ status: 200, marker: true, listsData: false });
    expect(classifyProbes(GATE, DENIED, files)).toEqual({
      result: 'reachable',
      reachable: ['identity.php'],
    });
  });

  it('finds a folder listing that names a data file', () => {
    expect(
      classifyProbes(
        GATE,
        inspectProbe(200, bytes('<a href="policy.php">policy.php</a>')),
        denied(),
      ),
    ).toMatchObject({ result: 'reachable', reachable: ['/'] });
  });

  it('reports everything refused as blocked, which proves no level', () => {
    // PHP ran the guard: 404 with an empty body; index.php is empty and answers 200.
    const files = denied();
    files[files.length - 1] = inspectProbe(200, bytes(''));
    expect(classifyProbes(GATE, inspectProbe(403, bytes('')), files)).toEqual({
      result: 'blocked',
      reachable: [],
    });
  });

  it('counts a redirect, a throttle, a server error or no answer as failed, never as blocked', () => {
    for (const status of [301, 302, 400, 429, 500, 503, 0]) {
      const files = denied();
      files[3] = inspectProbe(status, bytes(''));
      expect(classifyProbes(GATE, DENIED, files).result).toBe('failed');
      expect(
        classifyProbes(GATE, inspectProbe(status, bytes('')), denied()).result,
      ).toBe('failed');
    }
    const files = denied();
    files[3] = null;
    expect(classifyProbes(GATE, DENIED, files).result).toBe('failed');
    expect(classifyProbes(GATE, DENIED, denied().slice(0, 4)).result).toBe(
      'failed',
    );
    expect(classifyProbes(null, DENIED, denied()).result).toBe('failed');
  });

  it('still names a readable file when another probe failed', () => {
    const files = denied();
    files[2] = null;
    files[1] = inspectProbe(503, bytes('x __halt_compiler(); y'));
    expect(classifyProbes(GATE, DENIED, files)).toEqual({
      result: 'reachable',
      reachable: ['trust.php'],
    });
  });

  it('proves nothing when the URL does not answer like a gate', () => {
    for (const body of [
      '<html>Welcome</html>',
      '{"error":"not_found","x":1}',
      '{"error":1}',
      '[]',
    ])
      expect(
        classifyProbes({ status: 200, body }, DENIED, denied()).result,
      ).toBe('not_gate');
    expect(answersLikeGate(GATE)).toBe(true);
  });

  it('probes the folder, every data file and index.php', () => {
    const folder = 'moat-data-' + 'a'.repeat(32);
    expect(probePaths(folder).folder).toBe(`${folder}/`);
    expect(probePaths(folder).files).toContain(`${folder}/identity.php`);
    expect(probePaths(folder).files.at(-1)).toBe(`${folder}/index.php`);
  });

  it('knows every data file the PHP gate writes', () => {
    const src = path.join(__dirname, '../../../../gates/php/src');
    const names = [
      'Runtime/Gate.php',
      'Runtime/RateLimiter.php',
      'Runtime/BudgetStore.php',
      'Runtime/KillSwitch.php',
      'Hardening/WebFacts.php',
      'Storage/DataDir.php',
      'Runtime/BundlePull.php',
      'Runtime/OAuthToken.php',
      'Runtime/RequestLog.php',
    ].flatMap((file) =>
      [
        ...readFileSync(path.join(src, file), 'utf8').matchAll(
          // Constants, and the default of `DataDir::locked(…, string $lock = 'lock')`.
          /(?:public const [A-Z_]+|string \$lock) = '([a-z]+)'/g,
        ),
      ].map((match) => match[1]),
    );
    // `checkreq` lives only while the gate's own check runs.
    expect(names.filter((name) => name !== 'checkreq').sort()).toEqual(
      [...DATA_FILES].sort(),
    );
  });
});
