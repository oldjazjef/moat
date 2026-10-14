import { describe, expect, it } from 'vitest';
import { gateTestTarget } from './gate-test-target';

const target = (url: string, loopback = false) =>
  gateTestTarget(url, '/newsletter', loopback)?.href ?? null;

describe('gateTestTarget (FR-73, T-59)', () => {
  it('adds the route path to the gate file or folder', () => {
    expect(target('https://www.example.ch/api/moat-gate.php')).toBe(
      'https://www.example.ch/api/moat-gate.php/newsletter',
    );
    expect(target('https://gate.example.ch/')).toBe(
      'https://gate.example.ch/newsletter',
    );
    expect(target('https://www.example.ch:8443/moat-gate.php')).toBe(
      'https://www.example.ch:8443/moat-gate.php/newsletter',
    );
  });

  it('refuses anything but HTTPS (SEC-41)', () => {
    for (const url of [
      'http://www.example.ch/moat-gate.php',
      'ftp://www.example.ch/moat-gate.php',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'www.example.ch/moat-gate.php',
      '',
    ])
      expect(target(url)).toBeNull();
  });

  it('takes plain HTTP to this computer only in development', () => {
    expect(target('http://127.0.0.1:8080/moat-gate.php')).toBeNull();
    expect(target('http://127.0.0.1:8080/moat-gate.php', true)).toBe(
      'http://127.0.0.1:8080/moat-gate.php/newsletter',
    );
    expect(target('http://localhost:8080/moat-gate.php', true)).not.toBeNull();
    expect(target('http://[::1]:8080/moat-gate.php', true)).not.toBeNull();
    // Not this computer: still refused.
    expect(target('http://192.168.1.1/moat-gate.php', true)).toBeNull();
    expect(
      target('http://127.0.0.1.example.ch/moat-gate.php', true),
    ).toBeNull();
  });

  it('refuses credentials, query, fragment and odd characters', () => {
    for (const url of [
      'https://user:pw@www.example.ch/moat-gate.php',
      'https://www.example.ch/moat-gate.php?x=1',
      'https://www.example.ch/moat-gate.php?',
      'https://www.example.ch/moat-gate.php#a',
      'https://www.example.ch/moat gate.php',
      'https://www.example.ch\\@evil.example/moat-gate.php',
      `https://www.example.ch/${'a'.repeat(2100)}`,
    ])
      expect(target(url)).toBeNull();
  });
});
