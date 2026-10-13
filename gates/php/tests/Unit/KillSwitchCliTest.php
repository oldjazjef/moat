<?php

declare(strict_types=1);

namespace Moat\Gate\Tests\Unit;

use Moat\Gate\Build\Builder;
use Moat\Gate\Encoding\Base64Url;
use Moat\Gate\Runtime\KillSwitch;
use Moat\Gate\Storage\DataDir;
use Moat\Gate\Tests\Http\GateFixture;
use PHPUnit\Framework\TestCase;

/** `kill`, `revive` and the config age in `status` (SEC-15, FR-33, T-23) through the built gate's CLI. */
final class KillSwitchCliTest extends TestCase
{
    private const POLICY = '{"v":1,"upstreams":{"api.example.com":{"pathPrefixes":["/v1"],"methods":["POST"],"secrets":[]}},'
        . '"maxBodyBytes":4096,"maxResponseBytes":65536,"maxTimeoutMs":10000,"limits":{"perIp":{"requests":30,"windowSeconds":60},"total":{"requests":600,"windowSeconds":60},"maxClients":10000},'
        . '"maxConfigAgeSeconds":2592000}';

    private string $dir;
    /** @var non-empty-string */
    private string $signer;
    private string $gateId = '';

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/moat-kill-cli-' . bin2hex(random_bytes(6));
        mkdir($this->dir, 0o700);
        file_put_contents($this->dir . '/' . GateFixture::GATE_FILE, Builder::build(\dirname(__DIR__, 2) . '/src', '0.0.0-test', 'test'));
        $this->signer = sodium_crypto_sign_keypair();
        [, $out] = $this->cli('install', '--signer=' . Base64Url::encode(sodium_crypto_sign_publickey($this->signer)));
        self::assertSame(1, preg_match('/--gate-id=(\S+)/', $out, $match), $out);
        $this->gateId = $match[1];
    }

    protected function tearDown(): void
    {
        GateFixture::remove($this->dir);
    }

    public function testSec15KillSwitchesTheGateOffAndReviveOnAgain(): void
    {
        [$status, $out] = $this->cli('kill');
        self::assertSame(0, $status, $out);
        self::assertStringContainsString('whole gate is OFF', $out);
        self::assertTrue($this->switch()->gate);

        [$status] = $this->cli('revive');
        self::assertSame(0, $status);
        self::assertFalse($this->killFileExists());
        self::assertTrue($this->switch()->isOff());
    }

    public function testSec15RoutesAreSwitchedOffAndOnOneByOne(): void
    {
        $this->cli('kill', '--route=status');
        [, $out] = $this->cli('kill', '--route=newsletter');
        self::assertStringContainsString('route(s) OFF: newsletter, status', $out);
        $this->cli('revive', '--route=status');
        self::assertSame(['newsletter'], $this->switch()->routes);
        self::assertFalse($this->switch()->gate);
        $this->cli('revive', '--route=newsletter');
        self::assertFalse($this->killFileExists());
    }

    public function testSec15ReviveOfARouteDoesNotSwitchTheGateOn(): void
    {
        $this->cli('kill');
        $this->cli('kill', '--route=status');
        $this->cli('revive', '--route=status');
        self::assertTrue($this->switch()->gate);
    }

    public function testSec46ADamagedKillFileKeepsTheWholeGateOffUntilRevive(): void
    {
        file_put_contents($this->data()->path . '/kill.php', '');
        [, $out] = $this->cli('kill', '--route=status');
        self::assertStringContainsString('whole gate is OFF', $out);
        $this->cli('revive', '--route=status');
        self::assertTrue($this->switch()->gate);
        $this->cli('revive');
        self::assertTrue($this->switch()->isOff());
    }

    public function testBadRouteNamesAndOptionsAreUsageErrors(): void
    {
        self::assertSame(2, $this->cli('kill', '--route=Status')[0]);
        self::assertSame(2, $this->cli('kill', '--route=')[0]);
        self::assertSame(2, $this->cli('kill', '--route=../policy')[0]);
        self::assertSame(2, $this->cli('revive', '--all=1')[0]);
        self::assertFalse($this->killFileExists());
    }

    public function testSec15KillWorksWithoutPolicyOrBundle(): void
    {
        self::assertSame(0, $this->cli('kill', '--route=status')[0]);
        self::assertSame(['status'], $this->switch()->routes);
    }

    public function testStatusShowsTheKillSwitch(): void
    {
        $this->cli('kill', '--route=status');
        self::assertStringContainsString('Kill switch: route(s) OFF: status', $this->cli('status')[1]);
    }

    public function testT23StatusWarnsWhenTheConfigIsOlderThanThePolicyAllows(): void
    {
        $this->accept(time() - 40 * 86_400);
        $out = $this->cli('status')[1];
        self::assertStringContainsString('WARNING:', $out);
        self::assertStringContainsString('(40 days)', $out);
    }

    public function testKillingARouteTheBundleDoesNotHaveSaysSo(): void
    {
        $this->accept(time());
        self::assertStringContainsString('has no route "newsletter"', $this->cli('kill', '--route=newsletter')[1]);
        self::assertStringNotContainsString('has no route', $this->cli('kill', '--route=status')[1]);
    }

    public function testT23NoWarningForAFreshConfig(): void
    {
        $this->accept(time() - 86_400);
        self::assertStringNotContainsString('WARNING:', $this->cli('status')[1]);
    }

    private function accept(int $issuedAt): void
    {
        file_put_contents($this->dir . '/policy.json', self::POLICY);
        self::assertSame(0, $this->cli('policy', $this->dir . '/policy.json')[0]);
        $config = json_decode(
            '{"version":1,"upstreams":{"api":{"origin":"https://api.example.com","auth":null,"timeoutMs":5000}},'
            . '"routes":{"status":{"method":"POST","path":"/status","upstream":"api","upstreamPath":"/v1","maxBodyBytes":1024,'
            . '"contentTypes":["application/json"],"responseContentTypes":["application/json"],"enabled":true,"origins":[],"rateLimit":null}}}',
            false,
            512,
            JSON_THROW_ON_ERROR,
        );
        file_put_contents($this->dir . '/bundle.json', GateFixture::bundle($config, [], $this->gateId, $this->signer, 1, $issuedAt));
        [$status, $out] = $this->cli('accept', $this->dir . '/bundle.json');
        self::assertSame(0, $status, $out);
    }

    private function data(): DataDir
    {
        return DataDir::locate($this->dir) ?? throw new \RuntimeException('no data folder');
    }

    private function switch(): KillSwitch
    {
        clearstatcache();

        return KillSwitch::read($this->data());
    }

    private function killFileExists(): bool
    {
        clearstatcache();

        return is_file($this->data()->path . '/kill.php');
    }

    /** @return array{int, string} */
    private function cli(string ...$args): array
    {
        $outFile = $this->dir . '/cli.out';
        $process = proc_open([PHP_BINARY, $this->dir . '/' . GateFixture::GATE_FILE, ...array_values($args)], [1 => ['file', $outFile, 'w'], 2 => ['file', $outFile, 'a']], $pipes);
        if ($process === false) {
            throw new \RuntimeException('cannot start the gate CLI');
        }
        $status = proc_close($process);

        return [$status, (string) file_get_contents($outFile)];
    }
}
