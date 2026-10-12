<?php

declare(strict_types=1);

namespace Moat\Gate\Tests\Unit;

use Moat\Gate\Bundle\PinnedSigner;
use Moat\Gate\Rejection;
use Moat\Gate\Runtime\Gate;
use Moat\Gate\Runtime\Identity;
use Moat\Gate\Runtime\NotConfigured;
use Moat\Gate\Runtime\Trust;
use Moat\Gate\Storage\DataDir;
use Moat\Gate\Tests\Http\GateFixture;
use PHPUnit\Framework\TestCase;

/** Bundle acceptance and serving as an attacker would try them (docs/CRYPTO.md §4.3, steps 1–10). */
final class GateTest extends TestCase
{
    private const POLICY = '{"v":1,"upstreams":{"api.example.com":{"pathPrefixes":["/v1"],"methods":["POST"]}},'
        . '"maxBodyBytes":4096,"maxResponseBytes":65536,"maxTimeoutMs":10000}';

    private string $dir;
    private string $signer;
    private Identity $identity;

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/moat-gate-' . bin2hex(random_bytes(6));
        mkdir($this->dir, 0o700);
        $data = DataDir::create($this->dir);
        $this->identity = Identity::generate();
        $this->signer = sodium_crypto_sign_keypair();
        $data->write(Gate::IDENTITY, $this->identity->encode());
        $data->write(Gate::TRUST, self::trust($this->identity->gateId, $this->signer));
        $data->write(Gate::POLICY, self::POLICY);
    }

    protected function tearDown(): void
    {
        $data = DataDir::locate($this->dir);
        if ($data !== null) {
            foreach (['.htaccess', 'web.config', 'index.php', 'identity.php', 'trust.php', 'policy.php', 'bundle.php', 'state.php'] as $file) {
                if (is_file($data->path . '/' . $file)) {
                    unlink($data->path . '/' . $file);
                }
            }
            rmdir($data->path);
        }
        rmdir($this->dir);
    }

    public function testAcceptsAndServesAValidBundle(): void
    {
        $gate = Gate::open($this->dir);
        self::assertSame(1, $gate->accept($this->bundle(1), time())->version);
        self::assertSame(['contact'], array_keys(Gate::open($this->dir)->active(time())->config->routes));
    }

    public function testSec04RejectsTheSameOrALowerVersion(): void
    {
        Gate::open($this->dir)->accept($this->bundle(2), time());
        self::assertRejected('version_not_newer', fn() => Gate::open($this->dir)->accept($this->bundle(2), time()));
        self::assertRejected('version_not_newer', fn() => Gate::open($this->dir)->accept($this->bundle(1), time()));
    }

    public function testSec04DeletingTheBundleFileDoesNotReopenARollback(): void
    {
        $gate = Gate::open($this->dir);
        $gate->accept($this->bundle(3), time());
        unlink($gate->data->path . '/bundle.php');
        self::assertRejected('version_not_newer', fn() => Gate::open($this->dir)->accept($this->bundle(2), time()));
    }

    public function testSec07ABundleForAnotherGateIsRejected(): void
    {
        self::assertRejected('gate_mismatch', fn() => Gate::open($this->dir)->accept($this->bundle(1, gateId: 'AAAAAAAAAAAAAAAAAAAAAA'), time()));
    }

    public function testSec01ABundleFromAnUnpinnedSignerIsRejected(): void
    {
        $other = sodium_crypto_sign_keypair();
        self::assertRejected('threshold_not_met', fn() => Gate::open($this->dir)->accept($this->bundle(1, signer: $other), time()));
    }

    public function testSec11AConfigBeyondThePolicyIsRejectedAsAWhole(): void
    {
        $gate = Gate::open($this->dir);
        $gate->accept($this->bundle(1), time());
        self::assertRejected('policy_violation', fn() => $gate->accept($this->bundle(2, path: '/admin'), time()));
        self::assertSame(1, Gate::open($this->dir)->active(time())->version);
    }

    public function testSec11ANarrowedPolicyStopsServingABundleBeyondIt(): void
    {
        $gate = Gate::open($this->dir);
        $gate->accept($this->bundle(1), time());
        $gate->data->write(Gate::POLICY, str_replace('"/v1"', '"/v2"', self::POLICY));

        $this->expectException(NotConfigured::class);
        Gate::open($this->dir)->active(time());
    }

    public function testSec06ReplacedTrustStopsServingBundlesOfTheOldSigner(): void
    {
        $gate = Gate::open($this->dir);
        $gate->accept($this->bundle(1), time());
        $gate->data->write(Gate::TRUST, self::trust($this->identity->gateId, sodium_crypto_sign_keypair()));

        $this->expectException(NotConfigured::class);
        Gate::open($this->dir)->active(time());
    }

    public function testSec33ASecretSealedForAnotherGateIsRejectedAtAccept(): void
    {
        $other = Identity::generate();
        $sealed = ['token' => GateFixture::seal('x', $other->boxPublicKey, $this->identity->gateId, 'token')];
        self::assertRejected('secret_invalid', fn() => Gate::open($this->dir)->accept($this->bundle(1, sealed: $sealed), time()));
    }

    public function testDataFilesAreGuardedAndNamedRandomly(): void
    {
        $data = DataDir::locate($this->dir) ?? throw new \LogicException('no data folder');
        self::assertMatchesRegularExpression('/^moat-data-[0-9a-f]{32}$/', basename($data->path));
        foreach (['identity.php', 'trust.php', 'policy.php', 'index.php'] as $file) {
            self::assertStringStartsWith(DataDir::MARKER, (string) file_get_contents($data->path . '/' . $file));
        }
        self::assertFileExists($data->path . '/.htaccess');
        self::assertFileExists($data->path . '/web.config');
    }

    public function testSec46AGateWithoutABundleServesNothing(): void
    {
        $this->expectException(NotConfigured::class);
        Gate::open($this->dir)->active(time());
    }

    /** @param array<string, array<string, int|string>>|null $sealed */
    private function bundle(int $version, ?string $gateId = null, ?string $signer = null, string $path = '/v1/contacts', ?array $sealed = null): string
    {
        $gateId ??= $this->identity->gateId;
        $config = json_decode(
            '{"version":1,"upstreams":{"api":{"origin":"https://api.example.com","auth":{"type":"bearer","secret":"token"},"timeoutMs":5000}},'
            . '"routes":{"contact":{"method":"POST","path":"/contact","upstream":"api","upstreamPath":"' . $path . '","maxBodyBytes":1024,'
            . '"contentTypes":["application/json"],"responseContentTypes":["application/json"],"enabled":true}}}',
            false,
            512,
            JSON_THROW_ON_ERROR,
        );
        $sealed ??= ['token' => GateFixture::seal('TEST-ONLY', $this->identity->boxPublicKey, $gateId, 'token')];

        return GateFixture::bundle($config, $sealed, $gateId, $signer ?? $this->signer, $version);
    }

    private static function trust(string $gateId, string $signer): string
    {
        return (new Trust($gateId, 1, 1, [new PinnedSigner(sodium_crypto_sign_publickey($signer))]))->encode();
    }

    private static function assertRejected(string $code, callable $run): void
    {
        try {
            $run();
            self::fail('expected ' . $code);
        } catch (Rejection $rejection) {
            self::assertSame($code, $rejection->reason->value);
        }
    }
}
