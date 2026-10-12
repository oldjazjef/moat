<?php

declare(strict_types=1);

namespace Moat\Gate\Tests\Conformance;

use Moat\Gate\Bundle\BundleVerifier;
use Moat\Gate\Bundle\PinnedSigner;
use Moat\Gate\Bundle\VerificationContext;
use Moat\Gate\Crypto\KeyAlgorithm;
use Moat\Gate\Crypto\KeyId;
use Moat\Gate\Encoding\Base64Url;
use Moat\Gate\Json\StrictJson;
use Moat\Gate\Rejection;
use Moat\Gate\Secret\SecretOpener;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * The PHP gate against conformance/vectors/crypto/ — the same files libs/core passes
 * (docs/CRYPTO.md §11). A case is never edited here to make the gate pass.
 */
final class CryptoVectorsTest extends TestCase
{
    /** @return iterable<string, array{array<string, mixed>}> */
    public static function base64url(): iterable
    {
        return Vectors::cases('crypto/base64url.json');
    }

    /** @return iterable<string, array{array<string, mixed>}> */
    public static function json(): iterable
    {
        return Vectors::cases('crypto/json.json');
    }

    /** @return iterable<string, array{array<string, mixed>}> */
    public static function kid(): iterable
    {
        return Vectors::cases('crypto/kid.json');
    }

    /** @return iterable<string, array{array<string, mixed>}> */
    public static function bundle(): iterable
    {
        return Vectors::cases('crypto/bundle.json');
    }

    /** @return iterable<string, array{array<string, mixed>}> */
    public static function secret(): iterable
    {
        return Vectors::cases('crypto/secret.json');
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('base64url')]
    public function testBase64Url(array $case): void
    {
        $result = self::outcome(static fn(): string => bin2hex(Base64Url::decode($case['input'])));
        $expect = Vectors::map($case['expect']);
        self::assertSame(
            $expect['ok'] === true ? ['ok' => true, 'value' => $expect['hex']] : $expect,
            $result,
        );
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('json')]
    public function testStrictJson(array $case): void
    {
        $bytes = isset($case['inputHex'])
            ? (string) hex2bin(Vectors::string($case['inputHex']))
            : Vectors::string($case['input']);
        $result = self::outcome(static fn(): mixed => StrictJson::decode($bytes));
        self::assertSame(Vectors::map($case['expect']), $result['ok'] === true ? ['ok' => true] : $result);
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('kid')]
    public function testKeyId(array $case): void
    {
        $alg = KeyAlgorithm::from(Vectors::string($case['alg']));
        $publicKey = Base64Url::decode($case['publicKey']);
        self::assertSame($case['kid'], KeyId::of($alg, $publicKey));
        self::assertSame($case['fingerprint'], KeyId::fingerprint($alg, $publicKey));
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('bundle')]
    public function testBundle(array $case): void
    {
        $signers = [];
        foreach (Vectors::list(Vectors::load('crypto/bundle.json')['signers'] ?? null) as $signer) {
            $signer = Vectors::map($signer);
            $signers[Vectors::string($signer['name'])] = Vectors::string($signer['publicKey']);
        }
        $context = Vectors::map($case['context']);
        $pinned = [];
        foreach (Vectors::list($context['pinned']) as $name) {
            $pinned[] = new PinnedSigner(Base64Url::decode($signers[Vectors::string($name)] ?? null));
        }
        $verification = new VerificationContext(
            Vectors::string($context['gateId']),
            $pinned,
            Vectors::int($context['threshold']),
            Vectors::int($context['currentVersion']),
            Vectors::int($context['now']),
            $context['expiryEnabled'] === true,
        );
        $envelope = Vectors::string($case['envelope']);
        if (isset($case['padTo'])) {
            $envelope = str_pad($envelope, Vectors::int($case['padTo']), ' ');
        }

        $result = self::outcome(static function () use ($envelope, $verification): array {
            $bundle = BundleVerifier::verify($envelope, $verification);

            return ['gateId' => $bundle->gateId, 'version' => $bundle->version];
        });
        $expect = Vectors::map($case['expect']);
        if ($expect['ok'] === true) {
            self::assertSame(['ok' => true, 'value' => ['gateId' => $expect['gateId'], 'version' => $expect['version']]], $result);
        } else {
            self::assertSame($expect, $result);
        }
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('secret')]
    public function testSecret(array $case): void
    {
        $gate = Vectors::map(Vectors::load('crypto/secret.json')['gate'] ?? null);
        $gateSecretKey = Base64Url::decode($gate['secretKey']);
        // The sealed object reaches the gate inside a bundle: decode it the way the gate does.
        $sealed = StrictJson::decode(json_encode($case['sealed'], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
        $gateId = Vectors::string($case['gateId']);
        $secretName = Vectors::string($case['secretName']);

        $result = self::outcome(static fn(): string => bin2hex(SecretOpener::open($sealed, $gateSecretKey, $gateId, $secretName)));
        $expect = Vectors::map($case['expect']);
        self::assertSame(
            $expect['ok'] === true ? ['ok' => true, 'value' => $expect['plaintextHex']] : $expect,
            $result,
        );
    }

    /**
     * @param callable(): mixed $run
     *
     * @return array{ok: true, value: mixed}|array{ok: false, error: string}
     */
    private static function outcome(callable $run): array
    {
        try {
            return ['ok' => true, 'value' => $run()];
        } catch (Rejection $rejection) {
            return ['ok' => false, 'error' => $rejection->reason->value];
        }
    }
}
