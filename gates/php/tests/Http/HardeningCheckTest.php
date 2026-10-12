<?php

declare(strict_types=1);

namespace Moat\Gate\Tests\Http;

use PHPUnit\Framework\TestCase;

/**
 * `php moat-gate.php check --url=…` against a real gate (SEC-49, SEC-49a): the web process
 * records its facts on the check's own request, and the check from outside tells a host that
 * guards the data folder from one that serves it.
 */
final class HardeningCheckTest extends TestCase
{
    private static ?GateFixture $gate = null;
    /** @var array<string, int> mode → port of its fake web host */
    private static array $hosts = [];

    public static function setUpBeforeClass(): void
    {
        $dir = sys_get_temp_dir() . '/moat-hardening-' . bin2hex(random_bytes(6));
        mkdir($dir, 0o700);
        $gate = self::$gate = new GateFixture($dir, (string) file_get_contents(\dirname(__DIR__, 4) . '/conformance/http/gate.json'));
        foreach (['guarded', 'raw'] as $mode) {
            $portFile = $dir . '/webhost-' . $mode . '.port';
            $gate->spawn([PHP_BINARY, __DIR__ . '/fake-webhost.php', $gate->certFile, $gate->keyFile, $portFile, (string) $gate->port, $gate->site, $mode], $dir . '/webhost.log');
            self::$hosts[$mode] = (int) GateFixture::waitForFile($portFile);
        }
        // The test policy also sends the web hosts' name to loopback (testing block, TEST ONLY).
        $policy = json_decode($gate->policy, true, 512, JSON_THROW_ON_ERROR);
        self::assertIsArray($policy);
        self::assertIsArray($policy['testing']);
        self::assertIsArray($policy['testing']['resolve']);
        foreach (self::$hosts as $port) {
            $policy['testing']['resolve']['localhost:' . $port] = '127.0.0.1';
        }
        file_put_contents($dir . '/policy-hardening.json', json_encode($policy, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES));
        [$status] = $gate->run(['policy', $dir . '/policy-hardening.json']);
        self::assertSame(0, $status);
    }

    public static function tearDownAfterClass(): void
    {
        self::$gate?->stop();
        self::$gate = null;
    }

    public function testWithoutUrlNothingIsClaimed(): void
    {
        [, $out] = self::gate()->run(['check']);
        self::assertStringContainsString('From outside: not checked', $out);
        self::assertStringContainsString('external_not_checked', $out);
        // The testing block alone makes the gate unsafe for secrets.
        self::assertStringContainsString('Level:        H1, Unsafe for secrets', $out);
        self::assertStringContainsString('policy_testing', $out);
    }

    public function testGuardedHostBlocksTheDataFolder(): void
    {
        [$status, $out] = self::gate()->run(['check', '--url=https://localhost:' . self::$hosts['guarded'] . '/moat-gate.php']);
        self::assertSame(1, $status);
        self::assertStringContainsString('From outside: blocked', $out);
        self::assertStringNotContainsString('data_reachable', $out);
        // The check's own request reached the gate, so the web process has recorded its facts.
        self::assertStringContainsString('Web process:  user ', $out);
        self::assertStringContainsString('SAPI cli-server', $out);
    }

    public function testRawHostIsReported(): void
    {
        [$status, $out] = self::gate()->run(['check', '--url=https://localhost:' . self::$hosts['raw'] . '/moat-gate.php']);
        self::assertSame(1, $status);
        self::assertStringContainsString('From outside: REACHABLE', $out);
        self::assertStringContainsString('data_reachable', $out);
    }

    public function testUrlThatIsNotTheGateProvesNothing(): void
    {
        [$status, $out] = self::gate()->run(['check', '--url=https://localhost:' . self::$hosts['guarded'] . '/elsewhere/index.php']);
        self::assertSame(1, $status);
        self::assertStringContainsString('external_not_gate', $out);
    }

    public function testAnotherGateOnTheSameHostProvesNothing(): void
    {
        // A second, uninstalled copy answers like a gate (gate_not_configured) but never saw the nonce.
        $gate = self::gate();
        mkdir($gate->site . '/staging');
        copy($gate->site . '/' . GateFixture::GATE_FILE, $gate->site . '/staging/' . GateFixture::GATE_FILE);
        [, $out] = $gate->run(['check', '--url=https://localhost:' . self::$hosts['guarded'] . '/staging/moat-gate.php']);
        self::assertStringContainsString('From outside: the URL does not reach this gate', $out);
        self::assertStringContainsString('external_not_gate', $out);
    }

    public function testOnlyHttpsUrlsOfAPhpFile(): void
    {
        foreach (['http://localhost/moat-gate.php', 'https://localhost/', 'https://user@localhost/moat-gate.php', 'https://localhost/moat-gate.php?x=1'] as $url) {
            [$status, $out] = self::gate()->run(['check', '--url=' . $url]);
            self::assertSame(2, $status);
            self::assertStringContainsString('--url must be', $out);
        }
    }

    private static function gate(): GateFixture
    {
        return self::$gate ?? throw new \LogicException('no gate');
    }
}
