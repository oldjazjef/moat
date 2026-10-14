import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type DeployPackage,
  deployFiles,
  deployRefusal,
  packageName,
  writeDeployFolder,
  writeDeployZip,
} from './deploy';
import { MESSAGES } from './messages';

const PKG: DeployPackage = {
  project: 'shop',
  gate: 'www',
  gateId: 'AAAAAAAAAAAAAAAAAAAAAA',
  version: 3,
  locked: false,
  bundle: '{"payload":"eyJ2IjoxfQ","signatures":[]}',
  bundleSha256: 'ab'.repeat(32),
  policy: '{\n  "upstreams": {}\n}\n',
};

const dirs: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'moat-deploy-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const text = (data: Uint8Array) => Buffer.from(data).toString('utf8');

describe('deploy package (DT-05)', () => {
  it('holds the bundle unchanged, the policy and the instructions, in one folder', () => {
    const files = deployFiles(PKG, MESSAGES['de-CH'].deploy);
    expect(files.map((file) => file.name)).toEqual([
      'moat-www-v3/bundle-v3.json',
      'moat-www-v3/policy.json',
      'moat-www-v3/LIESMICH.txt',
    ]);
    expect(text(files[0]?.data ?? new Uint8Array())).toBe(PKG.bundle);
    expect(text(files[1]?.data ?? new Uint8Array())).toBe(PKG.policy);
    const readme = text(files[2]?.data ?? new Uint8Array());
    expect(readme).toContain('php moat-gate.php accept <Pfad>/bundle-v3.json');
    expect(readme).toContain(PKG.bundleSha256);
    expect(readme).toContain(PKG.gateId);
    expect(readme).not.toContain('sperrt');
    const en = deployFiles({ ...PKG, locked: true }, MESSAGES.en.deploy);
    expect(en[2]?.name).toBe('moat-www-v3/README.txt');
    expect(text(en[2]?.data ?? new Uint8Array())).toContain('(locks the gate)');
  });

  it('T-66: refuses another gate id or an older bundle than the last package', () => {
    expect(deployRefusal(PKG, undefined)).toBeNull();
    expect(deployRefusal(PKG, { gateId: PKG.gateId, version: 3 })).toBeNull();
    expect(deployRefusal(PKG, { gateId: PKG.gateId, version: 2 })).toBeNull();
    expect(deployRefusal(PKG, { gateId: PKG.gateId, version: 4 })).toEqual({
      status: 'refused',
      code: 'bundle_older',
    });
    expect(
      deployRefusal(PKG, { gateId: 'BBBBBBBBBBBBBBBBBBBBBB', version: 1 }),
    ).toEqual({ status: 'refused', code: 'gate_changed' });
  });

  it('the instructions compare with the gate first and install the policy only if accept needs it', () => {
    const readme = deployFiles(PKG, MESSAGES['de-CH'].deploy)[2]?.data;
    const text = Buffer.from(readme ?? new Uint8Array()).toString('utf8');
    const status = text.indexOf('php moat-gate.php status');
    const accept = text.indexOf('php moat-gate.php accept');
    const policy = text.indexOf('php moat-gate.php policy');
    expect(status).toBeGreaterThan(0);
    expect(accept).toBeGreaterThan(status);
    expect(policy).toBeGreaterThan(accept);
  });

  it('writes a new folder and never replaces one', () => {
    const parent = temp();
    const files = deployFiles(PKG, MESSAGES.en.deploy);
    expect(writeDeployFolder(parent, files)).toBeNull();
    const folder = join(parent, packageName(PKG));
    expect(readdirSync(folder).sort()).toEqual([
      'README.txt',
      'bundle-v3.json',
      'policy.json',
    ]);
    expect(readFileSync(join(folder, 'bundle-v3.json'), 'utf8')).toBe(
      PKG.bundle,
    );
    writeFileSync(join(folder, 'policy.json'), 'mine');
    expect(writeDeployFolder(parent, files)).toEqual({ status: 'exists' });
    expect(readFileSync(join(folder, 'policy.json'), 'utf8')).toBe('mine');
  });

  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
    'a folder it cannot write leaves nothing behind',
    () => {
      const parent = temp();
      const locked = join(parent, 'locked');
      mkdirSync(locked);
      chmodSync(locked, 0o500);
      try {
        expect(
          writeDeployFolder(locked, deployFiles(PKG, MESSAGES.en.deploy)),
        ).toEqual({ status: 'not_writable' });
      } finally {
        chmodSync(locked, 0o700);
      }
      expect(readdirSync(locked)).toEqual([]);
    },
  );

  it('saves the ZIP whole, replacing only the file the dialog confirmed', () => {
    const dir = temp();
    const path = join(dir, 'moat-www-v3.zip');
    writeFileSync(path, 'old');
    expect(writeDeployZip(path, new Uint8Array([1, 2, 3]))).toBeNull();
    expect([...readFileSync(path)]).toEqual([1, 2, 3]);
    expect(readdirSync(dir)).toEqual(['moat-www-v3.zip']);
    expect(
      writeDeployZip(join(dir, 'missing', 'x.zip'), new Uint8Array([1])),
    ).toEqual({ status: 'not_writable' });
  });
});
