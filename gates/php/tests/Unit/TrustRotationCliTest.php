<?php

declare(strict_types=1);

namespace Moat\Gate\Tests\Unit;

use Moat\Gate\Build\Builder;
use Moat\Gate\Encoding\Base64Url;
use Moat\Gate\Storage\DataDir;
use Moat\Gate\Tests\Http\GateFixture;
use PHPUnit\Framework\TestCase;

/** Key rotation through `trust` (SEC-08): old and new key side by side, never the active bundle's key dropped by accident. */
final class TrustRotationCliTest extends TestCase
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
        $this->dir = sys_get_temp_dir() . '/moat-trust-cli-' . bin2hex(random_bytes(6));
        mkdir($this->dir, 0o700);
        file_put_contents($this->dir . '/' . GateFixture::GATE_FILE, Builder::build(\dirname(__DIR__, 2) . '/src', '0.0.0-test', 'test'));
        $this->signer = sodium_crypto_sign_keypair();
        [, $out] = $this->cli('install', '--signer=' . Base64Url::encode(sodium_crypto_sign_publickey($this->signer)));
        if (preg_match('/--gate-id=(\S+)/', $out, $match) !== 1) {
            self::fail('install printed no gate id: ' . $out);
        }
        $this->gateId = $match[1];
    }

    protected function tearDown(): void
    {
        GateFixture::remove($this->dir);
    }

    public function testSec08RotationPinsBothKeysThenTheNewOneAlone(): void
    {
        $this->accept(time());
        $new = sodium_crypto_sign_keypair();
        $old = Base64Url::encode(sodium_crypto_sign_publickey($this->signer));
        $newKey = Base64Url::encode(sodium_crypto_sign_publickey($new));

        [$status, $out] = $this->cli('trust', '--signer=' . $old . ',' . $newKey);
        self::assertSame(0, $status, $out);
        $this->accept(time(), $new, 2);
        [$status, $out] = $this->cli('trust', '--signer=' . $newKey);
        self::assertSame(0, $status, $out);
        self::assertStringContainsString('version 2', $this->cli('status')[1]);
    }

    public function testSec08DroppingTheActiveBundlesKeyIsRefusedAndChangesNothing(): void
    {
        $this->accept(time());
        $before = (string) $this->data()->read('trust');
        $newKey = Base64Url::encode(sodium_crypto_sign_publickey(sodium_crypto_sign_keypair()));

        [$status, $out] = $this->cli('trust', '--signer=' . $newKey);
        self::assertSame(1, $status);
        self::assertStringContainsString('Rotate in two steps', $out);
        self::assertSame($before, $this->data()->read('trust'));
        self::assertStringContainsString('version 1', $this->cli('status')[1]);

        [$status, $out] = $this->cli('trust', '--signer=' . $newKey, '--force');
        self::assertSame(0, $status, $out);
        self::assertStringContainsString('none active', $this->cli('status')[1]);
    }

    public function testWithoutAnActiveBundleTrustIsReplacedFreely(): void
    {
        $newKey = Base64Url::encode(sodium_crypto_sign_publickey(sodium_crypto_sign_keypair()));
        self::assertSame(0, $this->cli('trust', '--signer=' . $newKey)[0]);
        self::assertSame(2, $this->cli('trust', '--signer=' . $newKey, 'extra')[0]);
    }

    private function accept(int $issuedAt, ?string $signer = null, int $version = 1): void
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
        $key = $signer ?? $this->signer;
        if ($key === '') {
            self::fail('no signing key');
        }
        file_put_contents($this->dir . '/bundle.json', GateFixture::bundle($config, [], $this->gateId, $key, $version, $issuedAt));
        [$status, $out] = $this->cli('accept', $this->dir . '/bundle.json');
        self::assertSame(0, $status, $out);
    }

    private function data(): DataDir
    {
        return DataDir::locate($this->dir) ?? throw new \RuntimeException('no data folder');
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
