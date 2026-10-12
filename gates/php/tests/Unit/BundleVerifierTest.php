<?php

declare(strict_types=1);

namespace Moat\Gate\Tests\Unit;

use Moat\Gate\Bundle\BundleVerifier;
use Moat\Gate\Bundle\PinnedSigner;
use Moat\Gate\Bundle\VerificationContext;
use Moat\Gate\Crypto\KeyAlgorithm;
use Moat\Gate\Crypto\KeyId;
use Moat\Gate\Encoding\Base64Url;
use Moat\Gate\Rejection;
use Moat\Gate\RejectionCode;
use PHPUnit\Framework\TestCase;

/** Attacker-side tests with fresh keys, next to the fixed conformance vectors. */
final class BundleVerifierTest extends TestCase
{
    public function testSec01ABundleSignedByAnUnpinnedKeyIsRejected(): void
    {
        // A fully compromised Cloud can sign anything with its own key — but not with a pinned one.
        $pinned = self::keyPair();
        $attacker = self::keyPair();
        $envelope = self::sign(self::payload(['version' => 99]), $attacker);

        $this->expectRejection(RejectionCode::ThresholdNotMet);
        BundleVerifier::verify($envelope, self::context($pinned));
    }

    public function testSec07ABundleForAnotherGateIsRejected(): void
    {
        $keys = self::keyPair();
        $envelope = self::sign(self::payload(['gateId' => 'another-gate']), $keys);

        $this->expectRejection(RejectionCode::GateMismatch);
        BundleVerifier::verify($envelope, self::context($keys));
    }

    public function testSec04AReplayedBundleIsRejected(): void
    {
        $keys = self::keyPair();
        $envelope = self::sign(self::payload(['version' => 5]), $keys);

        $this->expectRejection(RejectionCode::VersionNotNewer);
        BundleVerifier::verify($envelope, self::context($keys, currentVersion: 5));
    }

    public function testAcceptsWhatTheCoreFormatDescribes(): void
    {
        $keys = self::keyPair();
        $bundle = BundleVerifier::verify(self::sign(self::payload(), $keys), self::context($keys));

        self::assertSame(2, $bundle->version);
        self::assertSame('gate-under-test', $bundle->gateId);
    }

    /** @return non-empty-string */
    private static function keyPair(): string
    {
        $keyPair = sodium_crypto_sign_keypair();
        if ($keyPair === '') {
            throw new \LogicException('libsodium returned an empty key pair');
        }

        return $keyPair;
    }

    private function expectRejection(RejectionCode $code): void
    {
        $this->expectException(Rejection::class);
        $this->expectExceptionMessage($code->value);
    }

    /** @param array<string, mixed> $overrides */
    private static function payload(array $overrides = []): string
    {
        return json_encode([
            'type' => 'moat.bundle',
            'v' => 1,
            'gateId' => 'gate-under-test',
            'version' => 2,
            'issuedAt' => 100,
            'expiresAt' => null,
            'config' => ['version' => 1],
            'secrets' => new \stdClass(),
            ...$overrides,
        ], JSON_THROW_ON_ERROR);
    }

    /** @param non-empty-string $keyPair */
    private static function sign(string $payload, string $keyPair): string
    {
        $secretKey = sodium_crypto_sign_secretkey($keyPair);
        $publicKey = sodium_crypto_sign_publickey($keyPair);

        return json_encode([
            'moat' => 'bundle',
            'v' => 1,
            'payload' => Base64Url::encode($payload),
            'sigs' => [[
                'kid' => KeyId::of(KeyAlgorithm::Ed25519, $publicKey),
                'alg' => 'ed25519',
                'sig' => Base64Url::encode(sodium_crypto_sign_detached("moat:bundle:v1\n" . $payload, $secretKey)),
            ]],
        ], JSON_THROW_ON_ERROR);
    }

    /** @param non-empty-string $keyPair */
    private static function context(string $keyPair, int $currentVersion = 1): VerificationContext
    {
        return new VerificationContext(
            'gate-under-test',
            [new PinnedSigner(sodium_crypto_sign_publickey($keyPair))],
            1,
            $currentVersion,
            200,
            true,
        );
    }
}
