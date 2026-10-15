<?php

declare(strict_types=1);

namespace Moat\Gate\Tests\Unit;

use Moat\Gate\Build\Builder;
use Moat\Gate\Bundle\PinnedPasskey;
use Moat\Gate\Encoding\Base64Url;
use Moat\Gate\Runtime\Trust;
use Moat\Gate\Storage\DataDir;
use Moat\Gate\Tests\Http\GateFixture;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * Trust mode 2 through the gate's CLI (docs/CRYPTO.md §7, T-74): `install`/`trust --passkey`, a
 * bundle signed by a real P-256 key through OpenSSL, `status`, the mode change guard (SEC-06,
 * SEC-08) and the usage errors. The conformance vectors cover the verification rules themselves.
 */
final class PasskeyTrustCliTest extends TestCase
{
    private const RP_ID = 'moat.example.org';
    private const ORIGIN = 'app://moat';
    private const POLICY = '{"v":1,"upstreams":{"api.example.com":{"pathPrefixes":["/v1"],"methods":["POST"],"secrets":[]}},'
        . '"maxBodyBytes":4096,"maxResponseBytes":65536,"maxTimeoutMs":10000,"limits":{"perIp":{"requests":30,"windowSeconds":60},"total":{"requests":600,"windowSeconds":60},"maxClients":10000},'
        . '"maxConfigAgeSeconds":2592000}';

    private string $dir;
    private string $gateId = '';
    /** @var non-empty-string */
    private string $edSigner;
    private \OpenSSLAsymmetricKey $passkey;

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/moat-passkey-cli-' . bin2hex(random_bytes(6));
        mkdir($this->dir, 0o700);
        file_put_contents($this->dir . '/' . GateFixture::GATE_FILE, Builder::build(\dirname(__DIR__, 2) . '/src', '0.0.0-test', 'test'));
        $this->edSigner = sodium_crypto_sign_keypair();
        $this->passkey = self::newPasskey();
    }

    protected function tearDown(): void
    {
        GateFixture::remove($this->dir);
    }

    public function testInstallPinsAPasskeyAsTrustModeTwo(): void
    {
        [$status, $out] = $this->install();
        self::assertSame(0, $status, $out);
        self::assertStringContainsString('Trust mode: 2 (signed with passkey)', $out);
        self::assertStringContainsString('Passkey:    MOAT-', $out);
        self::assertStringContainsString('rpId ' . self::RP_ID . ', origins ' . self::ORIGIN, $out);
        $trust = Trust::parse((string) $this->data()->read('trust'), $this->gateId);
        self::assertSame(2, $trust->mode);
        $signer = $trust->signers[0];
        if (!$signer instanceof PinnedPasskey) {
            self::fail('not a passkey');
        }
        self::assertSame(self::point($this->passkey), $signer->publicKey);
        self::assertStringContainsString('Passkey:    MOAT-', $this->cli('status')[1]);
    }

    public function testAPasskeySignedBundleIsAcceptedEndToEnd(): void
    {
        $this->install();
        $this->policy();
        [$status, $out] = $this->cli('accept', $this->bundle(1));
        self::assertSame(0, $status, $out);
        self::assertStringContainsString('Accepted bundle version 1', $out);
        self::assertStringContainsString('version 1', $this->cli('status')[1]);
    }

    public function testT74ABundleSignedOnAnotherOriginIsRejectedAndTheOldOneStays(): void
    {
        $this->install();
        $this->policy();
        self::assertSame(0, $this->cli('accept', $this->bundle(1))[0]);
        [$status, $out] = $this->cli('accept', $this->bundle(2, 'https://evil.example'));
        self::assertSame(1, $status);
        self::assertStringContainsString('rejected: signature_invalid', $out);
        self::assertStringContainsString('version 1', $this->cli('status')[1]);
    }

    public function testT74AnEd25519SignatureNeverCountsInModeTwo(): void
    {
        $this->install();
        $this->policy();
        $path = $this->dir . '/bundle.json';
        file_put_contents($path, GateFixture::bundle($this->config(), [], $this->gateId, $this->edSigner, 1, time()));
        [$status, $out] = $this->cli('accept', $path);
        self::assertSame(1, $status);
        self::assertStringContainsString('rejected: threshold_not_met', $out);
    }

    public function testSec06ChangingTheModeNeedsForceAndTheKeysOfTheOldModeStopCounting(): void
    {
        $this->install(mode1: true);
        $this->policy();
        $path = $this->dir . '/bundle.json';
        file_put_contents($path, GateFixture::bundle($this->config(), [], $this->gateId, $this->edSigner, 1, time()));
        self::assertSame(0, $this->cli('accept', $path)[0]);
        $before = (string) $this->data()->read('trust');

        [$status, $out] = $this->cli('trust', ...$this->passkeyOptions());
        self::assertSame(1, $status);
        self::assertStringContainsString('change between trust modes', $out);
        self::assertSame($before, $this->data()->read('trust'));
        self::assertStringContainsString('version 1', $this->cli('status')[1]);

        [$status, $out] = $this->cli('trust', ...[...$this->passkeyOptions(), '--force']);
        self::assertSame(0, $status, $out);
        self::assertStringContainsString('trust mode 2', $out);
        self::assertStringContainsString('none active', $this->cli('status')[1]);
        self::assertSame(0, $this->cli('accept', $this->bundle(2))[0]);

        // And back: the passkey bundle is active, so dropping its signer is refused again.
        [$status, $out] = $this->cli('trust', '--signer=' . Base64Url::encode(sodium_crypto_sign_publickey($this->edSigner)));
        self::assertSame(1, $status);
        self::assertStringContainsString('change between trust modes', $out);
    }

    public function testTwoPasskeysWithAThresholdOfTwo(): void
    {
        $second = self::newPasskey();
        $args = [
            'install',
            '--passkey=' . Base64Url::encode(self::point($this->passkey)) . ',' . Base64Url::encode(self::point($second)),
            '--rp-id=' . self::RP_ID,
            '--origin=' . self::ORIGIN . ',https://moat.example.org:8443',
            '--threshold=2',
        ];
        [$status, $out] = $this->cli(...$args);
        self::assertSame(0, $status, $out);
        self::assertStringContainsString('2 of 2 signatures', $out);
        self::assertSame(2, substr_count($out, 'Passkey:    MOAT-'));
        $this->gateId = self::gateId($out);
        $trust = Trust::parse((string) $this->data()->read('trust'), $this->gateId);
        self::assertSame(2, $trust->threshold);
        $first = $trust->signers[0];
        if (!$first instanceof PinnedPasskey) {
            self::fail('not a passkey');
        }
        self::assertSame([self::ORIGIN, 'https://moat.example.org:8443'], $first->origins);
    }

    /** @return iterable<string, array{list<string>}> */
    public static function usageErrors(): iterable
    {
        $point = static fn(string $bytes): string => Base64Url::encode($bytes);
        $good = ['--rp-id=' . self::RP_ID, '--origin=' . self::ORIGIN];
        yield 'signer and passkey together' => [['--signer=' . $point(str_repeat("\1", 32)), '--passkey=' . $point("\4" . str_repeat("\1", 64)), ...$good]];
        yield 'passkey without rp id' => [['--passkey=' . $point("\4" . str_repeat("\1", 64)), '--origin=' . self::ORIGIN]];
        yield 'passkey without origin' => [['--passkey=' . $point("\4" . str_repeat("\1", 64)), '--rp-id=' . self::RP_ID]];
        yield 'rp id without passkey' => [['--signer=' . $point(str_repeat("\1", 32)), '--rp-id=' . self::RP_ID]];
        yield 'a point of 64 bytes' => [['--passkey=' . $point(str_repeat("\4", 64)), ...$good]];
        yield 'a compressed point' => [['--passkey=' . $point("\2" . str_repeat("\1", 32)), ...$good]];
        yield 'a point that is not on the curve' => [['--passkey=' . $point("\4" . str_repeat("\1", 64)), ...$good]];
        yield 'a point with padding' => [['--passkey=' . $point("\4" . str_repeat("\1", 64)) . '=', ...$good]];
    }

    /** @param list<string> $options */
    #[DataProvider('usageErrors')]
    public function testUsageErrorsPinNothing(array $options): void
    {
        [$status, $out] = $this->cli(...['install', ...$options]);
        self::assertSame(2, $status, $out);
        self::assertNull(DataDir::locate($this->dir), 'a refused install leaves no data folder');
    }

    /** @return iterable<string, array{string, string}> */
    public static function badRelyingParties(): iterable
    {
        yield 'upper case rpId' => ['Moat.example.org', self::ORIGIN];
        yield 'rpId with a scheme' => ['https://moat.example.org', self::ORIGIN];
        yield 'plain http origin' => [self::RP_ID, 'http://moat.example.org'];
        yield 'origin with a trailing slash' => [self::RP_ID, 'https://moat.example.org/'];
        yield 'origin with the default port' => [self::RP_ID, 'https://moat.example.org:443'];
        yield 'duplicate origins' => [self::RP_ID, 'app://moat,app://moat'];
        yield 'nine origins' => [self::RP_ID, 'app://a,app://b,app://c,app://d,app://e,app://f,app://g,app://h,app://i'];
    }

    #[DataProvider('badRelyingParties')]
    public function testARelyingPartyThatIsNotInTheGrammarIsRefused(string $rpId, string $origin): void
    {
        [$status, $out] = $this->cli('install', '--passkey=' . Base64Url::encode(self::point($this->passkey)), '--rp-id=' . $rpId, '--origin=' . $origin);
        self::assertSame(2, $status, $out);
        self::assertNull(DataDir::locate($this->dir));
    }

    public function testMode2NeedsOpensslAndTheOtherModesDoNot(): void
    {
        $this->install();
        $trust = Trust::parse((string) $this->data()->read('trust'), $this->gateId);
        self::assertNull($trust->missingExtension());
        self::assertSame('openssl', $trust->missingExtension(static fn(string $name): bool => $name !== 'openssl'));
        $mode1 = new Trust($this->gateId, 1, 1, []);
        self::assertNull($mode1->missingExtension(static fn(): bool => false));
    }

    /** @return array{int, string} */
    private function install(bool $mode1 = false): array
    {
        $result = $mode1
            ? $this->cli('install', '--signer=' . Base64Url::encode(sodium_crypto_sign_publickey($this->edSigner)))
            : $this->cli(...['install', ...$this->passkeyOptions()]);
        $this->gateId = self::gateId($result[1]);

        return $result;
    }

    /** @return list<string> */
    private function passkeyOptions(): array
    {
        return ['--passkey=' . Base64Url::encode(self::point($this->passkey)), '--rp-id=' . self::RP_ID, '--origin=' . self::ORIGIN];
    }

    private static function gateId(string $out): string
    {
        if (preg_match('/--gate-id=(\S+)/', $out, $match) !== 1) {
            self::fail('install printed no gate id: ' . $out);
        }

        return $match[1];
    }

    private function policy(): void
    {
        file_put_contents($this->dir . '/policy.json', self::POLICY);
        self::assertSame(0, $this->cli('policy', $this->dir . '/policy.json')[0]);
    }

    private function config(): \stdClass
    {
        $config = json_decode(
            '{"version":1,"upstreams":{"api":{"origin":"https://api.example.com","auth":null,"timeoutMs":5000}},'
            . '"routes":{"status":{"method":"POST","path":"/status","upstream":"api","upstreamPath":"/v1","maxBodyBytes":1024,'
            . '"contentTypes":["application/json"],"responseContentTypes":["application/json"],"enabled":true,"origins":[],"rateLimit":null}}}',
            false,
            512,
            JSON_THROW_ON_ERROR,
        );

        return $config;
    }

    /** A bundle file signed by the test passkey the way a browser or desktop ceremony would. */
    private function bundle(int $version, string $origin = self::ORIGIN): string
    {
        $ed = json_decode(GateFixture::bundle($this->config(), [], $this->gateId, $this->edSigner, $version, time()), true, 512, JSON_THROW_ON_ERROR);
        self::assertIsArray($ed);
        $payload = Base64Url::decode($ed['payload']);
        $authenticatorData = hash('sha256', self::RP_ID, true) . "\x05\x00\x00\x00\x01";
        $clientData = json_encode([
            'type' => 'webauthn.get',
            'challenge' => Base64Url::encode(hash('sha256', "moat:bundle:v1\n" . $payload, true)),
            'origin' => $origin,
            'crossOrigin' => false,
        ], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
        $der = '';
        self::assertTrue(openssl_sign($authenticatorData . hash('sha256', $clientData, true), $der, $this->passkey, OPENSSL_ALGO_SHA256));
        if (!\is_string($der)) {
            self::fail('no signature');
        }
        $path = $this->dir . '/bundle.json';
        file_put_contents($path, json_encode([
            'moat' => 'bundle',
            'v' => 1,
            'payload' => $ed['payload'],
            'sigs' => [[
                'kid' => (new PinnedPasskey(self::point($this->passkey), self::RP_ID, [self::ORIGIN]))->kid,
                'alg' => 'webauthn-es256',
                'sig' => Base64Url::encode($der),
                'authenticatorData' => Base64Url::encode($authenticatorData),
                'clientDataJSON' => Base64Url::encode($clientData),
            ]],
        ], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES));

        return $path;
    }

    private static function newPasskey(): \OpenSSLAsymmetricKey
    {
        $key = openssl_pkey_new(['curve_name' => 'prime256v1', 'private_key_type' => OPENSSL_KEYTYPE_EC]);
        if ($key === false) {
            self::fail('OpenSSL cannot make a P-256 key');
        }

        return $key;
    }

    /** The uncompressed point 0x04 ‖ X ‖ Y of an OpenSSL key. */
    private static function point(\OpenSSLAsymmetricKey $key): string
    {
        $details = openssl_pkey_get_details($key);
        $ec = \is_array($details) && \is_array($details['ec'] ?? null) ? $details['ec'] : [];
        $x = $ec['x'] ?? null;
        $y = $ec['y'] ?? null;
        if (!\is_string($x) || !\is_string($y)) {
            self::fail('no EC details');
        }

        return "\x04" . str_pad($x, 32, "\0", STR_PAD_LEFT) . str_pad($y, 32, "\0", STR_PAD_LEFT);
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
