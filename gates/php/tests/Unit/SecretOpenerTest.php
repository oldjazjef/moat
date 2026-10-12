<?php

declare(strict_types=1);

namespace Moat\Gate\Tests\Unit;

use Moat\Gate\Encoding\Base64Url;
use Moat\Gate\Json\StrictJson;
use Moat\Gate\Rejection;
use Moat\Gate\Secret\SecretOpener;
use PHPUnit\Framework\TestCase;

final class SecretOpenerTest extends TestCase
{
    private const PLANTED_SECRET = 'sk-PLANTED-SECRET-must-never-appear';

    public function testSec34APlantedSecretNeverAppearsInARejection(): void
    {
        $gate = sodium_crypto_box_keypair();
        $sealed = self::seal(self::PLANTED_SECRET, sodium_crypto_box_publickey($gate), 'g1', 's', 1);

        self::assertSame(self::PLANTED_SECRET, SecretOpener::open($sealed, sodium_crypto_box_secretkey($gate), 'g1', 's'));
        try {
            SecretOpener::open($sealed, sodium_crypto_box_secretkey($gate), 'g2', 's');
            self::fail('expected a rejection');
        } catch (Rejection $rejection) {
            self::assertSame('secret_invalid', $rejection->getMessage());
            self::assertStringNotContainsString(self::PLANTED_SECRET, (string) $rejection);
        }
    }

    public function testSec31AnotherGateKeyCannotOpenIt(): void
    {
        $gate = sodium_crypto_box_keypair();
        $other = sodium_crypto_box_keypair();
        $sealed = self::seal('x', sodium_crypto_box_publickey($gate), 'g1', 's', 1);

        $this->expectException(Rejection::class);
        SecretOpener::open($sealed, sodium_crypto_box_secretkey($other), 'g1', 's');
    }

    /** Sealing lives in libs/core; this mirror exists only to produce fresh test input. */
    private static function seal(string $plaintext, string $gatePublicKey, string $gateId, string $name, int $version): mixed
    {
        $ephemeral = sodium_crypto_box_keypair();
        $epk = sodium_crypto_box_publickey($ephemeral);
        $shared = sodium_crypto_scalarmult(sodium_crypto_box_secretkey($ephemeral), $gatePublicKey);
        $key = sodium_crypto_generichash('moat:secret:v1' . $epk . $gatePublicKey, $shared, 32);
        $nonce = random_bytes(SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_NPUBBYTES);
        $ct = sodium_crypto_aead_xchacha20poly1305_ietf_encrypt($plaintext, "moat:secret:v1|{$gateId}|{$name}|{$version}", $nonce, $key);

        return StrictJson::decode(json_encode([
            'v' => 1,
            'alg' => SecretOpener::ALG,
            'secretVersion' => $version,
            'epk' => Base64Url::encode($epk),
            'nonce' => Base64Url::encode($nonce),
            'ct' => Base64Url::encode($ct),
        ], JSON_THROW_ON_ERROR));
    }
}
