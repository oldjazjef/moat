<?php

declare(strict_types=1);

namespace Moat\Gate\Runtime;

use Moat\Gate\Config\ClientProtection;
use Moat\Gate\Config\JwtAlg;
use Moat\Gate\Config\JwtKey;
use Moat\Gate\Encoding\Base64Url;
use Moat\Gate\Http\Failure;
use Moat\Gate\Http\GateError;
use Moat\Gate\Http\Request;
use Moat\Gate\Json\JsonObject;
use Moat\Gate\Json\StrictJson;
use Moat\Gate\Rejection;
use Moat\Gate\Upstream\UpstreamClient;
use Moat\Gate\Upstream\UpstreamRequest;

/**
 * FR-16: a route's client checks (libs/core http/client.ts, conformance/http/gate-client.json).
 * Every failure is the same 401 `client_unauthorized`, without saying which check failed.
 */
final class ClientCheck
{
    /** Seconds `exp` and `nbf` may be off. */
    public const LEEWAY = 60;
    public const MAX_JWT = 8192;
    private const MAX_TURNSTILE_TOKEN = 2048;

    /** The API key and the JWT: before the limits, without any call. */
    public static function credentials(Request $request, ClientProtection $client, ActiveBundle $bundle, Gate $gate, int $now): void
    {
        if ($client->apiKey !== null) {
            $given = $request->header($client->apiKey[0]) ?? self::refuse();
            try {
                $key = $gate->openSecret($bundle, $client->apiKey[1]);
            } catch (Rejection) {
                throw new Failure(GateError::SecretUnavailable);
            }
            $same = hash_equals($key, $given);
            sodium_memzero($key);
            if (!$same) {
                self::refuse();
            }
        }
        if ($client->jwt !== null && !self::jwtValid($request->header('Authorization'), $client->jwt, $now)) {
            self::refuse();
        }
    }

    /**
     * The honeypot: a JSON object whose field is there and neither "" nor null. A body that is no
     * strict JSON object is left to the route's other checks.
     */
    public static function honeypot(ClientProtection $client, string $body): void
    {
        if ($client->honeypot === null) {
            return;
        }
        try {
            $value = StrictJson::decode($body);
        } catch (Rejection) {
            return;
        }
        if ($value instanceof JsonObject && $value->has($client->honeypot)) {
            $filled = $value->get($client->honeypot);
            if ($filled !== '' && $filled !== null) {
                self::refuse();
            }
        }
    }

    /** Turnstile: the token from the header, checked at the verify endpoint with the secret. */
    public static function turnstile(Request $request, ClientProtection $client, ActiveBundle $bundle, Gate $gate): void
    {
        if ($client->turnstile === null) {
            return;
        }
        [$header, $name, $endpoint] = $client->turnstile;
        $token = $request->header($header) ?? self::refuse();
        if (\strlen($token) > self::MAX_TURNSTILE_TOKEN) {
            self::refuse();
        }
        try {
            $secret = $gate->openSecret($bundle, $name);
        } catch (Rejection) {
            throw new Failure(GateError::SecretUnavailable);
        }
        $form = 'secret=' . rawurlencode($secret) . '&response=' . rawurlencode($token);
        try {
            $response = UpstreamClient::send(new UpstreamRequest(
                'POST',
                $endpoint->host(),
                $endpoint->port(),
                $endpoint->path,
                ['Accept' => 'application/json', 'Content-Type' => 'application/x-www-form-urlencoded'],
                $form,
                $bundle->policy->maxTimeoutMs,
                min(65_536, $bundle->policy->maxResponseBytes),
                ['application/json'],
            ), $bundle->policy);
        } catch (Failure) {
            // Unreachable or a wrong answer: nobody gets in (SEC-46).
            self::refuse();
        } finally {
            sodium_memzero($secret);
            sodium_memzero($form);
        }
        try {
            $answer = $response->status === 200 ? StrictJson::decode($response->body) : null;
        } catch (Rejection) {
            $answer = null;
        }
        if (!$answer instanceof JsonObject || $answer->get('success') !== true) {
            self::refuse();
        }
    }

    /** @param array{string, string, list<JwtKey>} $jwt issuer, audience, keys */
    private static function jwtValid(?string $authorization, array $jwt, int $now): bool
    {
        if (
            $authorization === null || \strlen($authorization) > self::MAX_JWT
            || preg_match('/^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/D', $authorization, $parts) !== 1
        ) {
            return false;
        }
        [$issuer, $audience, $keys] = $jwt;
        try {
            $header = StrictJson::decode(Base64Url::decode($parts[1]));
            $signature = Base64Url::decode($parts[3]);
        } catch (Rejection) {
            return false;
        }
        if (!$header instanceof JsonObject || !\is_string($header->get('kid')) || !\is_string($header->get('alg'))) {
            return false;
        }
        $key = null;
        foreach ($keys as $candidate) {
            if (hash_equals($candidate->kid, $header->get('kid'))) {
                $key = $candidate;
            }
        }
        // The algorithm is the key's: a token that names another one is refused (no `none`, no
        // HS256 with the public key as a shared secret).
        if ($key === null || $header->get('alg') !== $key->alg->value) {
            return false;
        }
        if (!self::signatureValid($key, $parts[1] . '.' . $parts[2], $signature)) {
            return false;
        }
        try {
            $claims = StrictJson::decode(Base64Url::decode($parts[2]));
        } catch (Rejection) {
            return false;
        }
        if (!$claims instanceof JsonObject) {
            return false;
        }
        $aud = $claims->get('aud');
        $exp = $claims->get('exp');
        $nbf = $claims->has('nbf') ? $claims->get('nbf') : $now;

        return $claims->get('iss') === $issuer
            && ($aud === $audience || (\is_array($aud) && array_is_list($aud) && \in_array($audience, $aud, true)))
            && \is_int($exp) && $now < $exp + self::LEEWAY
            && \is_int($nbf) && $nbf <= $now + self::LEEWAY;
    }

    private static function signatureValid(JwtKey $key, string $input, string $signature): bool
    {
        if ($key->alg === JwtAlg::EdDSA) {
            return \strlen($signature) === SODIUM_CRYPTO_SIGN_BYTES
                && sodium_crypto_sign_verify_detached($signature, $input, substr($key->spki, 12));
        }
        // ES256 and RS256 need ext-openssl; without it nobody gets in, and the host is at fault.
        if (!\extension_loaded('openssl')) {
            throw new Failure(GateError::Internal);
        }
        $pem = "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($key->spki), 64, "\n") . "-----END PUBLIC KEY-----\n";
        $public = openssl_pkey_get_public($pem);
        if ($public === false) {
            return false;
        }
        if ($key->alg === JwtAlg::ES256) {
            if (\strlen($signature) !== 64) {
                return false;
            }
            $signature = self::derSignature(substr($signature, 0, 32), substr($signature, 32));
        } else {
            $details = openssl_pkey_get_details($public);
            if (!\is_array($details) || ($details['type'] ?? null) !== OPENSSL_KEYTYPE_RSA || !\is_int($details['bits'] ?? null) || $details['bits'] < 2048) {
                return false;
            }
        }

        return openssl_verify($input, $signature, $public, OPENSSL_ALGO_SHA256) === 1;
    }

    /** JWS ES256 `r ‖ s` as the DER ECDSA-Sig-Value openssl reads. */
    private static function derSignature(string $r, string $s): string
    {
        $integer = static function (string $bytes): string {
            $bytes = ltrim($bytes, "\x00");
            if ($bytes === '' || \ord($bytes[0]) >= 0x80) {
                $bytes = "\x00" . $bytes;
            }

            return "\x02" . \chr(\strlen($bytes)) . $bytes;
        };
        $sequence = $integer($r) . $integer($s);

        return "\x30" . \chr(\strlen($sequence)) . $sequence;
    }

    private static function refuse(): never
    {
        throw new Failure(GateError::ClientUnauthorized);
    }
}
