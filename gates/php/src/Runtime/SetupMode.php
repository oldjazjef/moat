<?php

declare(strict_types=1);

namespace Moat\Gate\Runtime;

use Moat\Gate\Bundle\PinnedPasskey;
use Moat\Gate\Bundle\PinnedSigner;
use Moat\Gate\Crypto\KeyAlgorithm;
use Moat\Gate\Crypto\KeyId;
use Moat\Gate\Encoding\Base64Url;
use Moat\Gate\Http\GateError;
use Moat\Gate\Http\Request;
use Moat\Gate\Http\Response;
use Moat\Gate\Json\JsonObject;
use Moat\Gate\Json\StrictJson;
use Moat\Gate\Rejection;

/**
 * The setup mode (SEC-28, SEC-32, docs/CRYPTO.md §8, conformance/http/gate-setup.json): for a
 * while after `install` or `php moat-gate.php setup`, `GET <gate file>?moat-setup` with the header
 * `X-Moat-Setup-Token` shows the gate's public identity — gate id, box key, the pinned signers'
 * fingerprints — so a host without a shell can be compared too. Nothing in it is secret and
 * nothing can be changed through it (SEC-40). The data file `setup` holds only the token's
 * SHA-256, the expiry and the version accepted when it was switched on: a newer bundle, the expiry
 * or a damaged file switch it off for good, and only the command line switches it on again.
 * Every other answer is the gate's plain 404, so it reveals nothing about the mode.
 */
final class SetupMode
{
    public const FILE = 'setup';
    public const QUERY = 'moat-setup';
    public const HEADER = 'X-Moat-Setup-Token';
    public const LIFETIME_SECONDS = 1800;
    private const TOKEN_BYTES = 32;

    /** True for the setup request's shape: `?moat-setup` on the gate file itself. */
    public static function isSetupRequest(?string $rawPath, string $query): bool
    {
        return $rawPath === null && $query === self::QUERY;
    }

    /** Switches the mode on for LIFETIME_SECONDS; returns the token to show once (base64url). */
    public static function enable(Gate $gate, int $now): string
    {
        $token = random_bytes(self::TOKEN_BYTES);
        $text = Base64Url::encode($token);
        sodium_memzero($token);
        $gate->data->write(self::FILE, (string) json_encode([
            'v' => 1,
            'tokenHash' => Base64Url::encode(hash('sha256', $text, true)),
            'expiresAt' => $now + self::LIFETIME_SECONDS,
            'afterVersion' => $gate->highestVersion(),
        ], JSON_THROW_ON_ERROR));

        return $text;
    }

    /** Seconds the mode stays on, or null when it is off. */
    public static function remaining(Gate $gate, int $now): ?int
    {
        $state = self::state($gate);
        if ($state === null || $now >= $state[1] || $gate->highestVersion() > $state[2]) {
            return null;
        }

        return $state[1] - $now;
    }

    public static function answer(Request $request, Gate $gate, int $now): Response
    {
        $notFound = Response::error(GateError::NotFound);
        $given = $request->header(self::HEADER);
        if ($request->method !== 'GET' || $given === null || \strlen($given) > 128) {
            return $notFound;
        }
        $state = self::state($gate);
        if ($state === null) {
            return $notFound;
        }
        [$tokenHash, $expiresAt, $afterVersion] = $state;
        if ($now >= $expiresAt || $gate->highestVersion() > $afterVersion) {
            // For good: the next `setup` on the command line writes a new file.
            $gate->data->remove(self::FILE);

            return $notFound;
        }
        if (!hash_equals($tokenHash, hash('sha256', $given, true)) || $gate->trust === null) {
            return $notFound;
        }
        $trust = $gate->trust;
        $identity = $gate->identity;

        return new Response(200, ['Content-Type' => 'application/json'], json_encode([
            'gateId' => $identity->gateId,
            'boxKey' => Base64Url::encode($identity->boxPublicKey),
            'boxKeyFingerprint' => KeyId::fingerprint(KeyAlgorithm::X25519, $identity->boxPublicKey),
            'signers' => array_map(static fn(PinnedSigner|PinnedPasskey $signer): array => [
                'kid' => $signer->kid,
                'fingerprint' => KeyId::fingerprint($signer->alg, $signer->publicKey),
            ], $trust->signers),
            'threshold' => $trust->threshold,
            'mode' => $trust->mode,
        ], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES) . "\n");
    }

    /** @return ?array{string, int, int} token hash, expiry, version when switched on; null when off or damaged */
    private static function state(Gate $gate): ?array
    {
        try {
            $value = StrictJson::decode($gate->data->read(self::FILE) ?? '');
            if (!$value instanceof JsonObject || !$value->hasExactKeys('v', 'tokenHash', 'expiresAt', 'afterVersion') || $value->get('v') !== 1) {
                return null;
            }
            $hash = Base64Url::decode($value->get('tokenHash'));
            $expiresAt = $value->get('expiresAt');
            $afterVersion = $value->get('afterVersion');
        } catch (Rejection | \RuntimeException) {
            return null;
        }
        if (\strlen($hash) !== 32 || !\is_int($expiresAt) || !\is_int($afterVersion)) {
            return null;
        }

        return [$hash, $expiresAt, $afterVersion];
    }
}
