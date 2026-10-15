<?php

declare(strict_types=1);

namespace Moat\Gate\Bundle;

use Moat\Gate\Crypto\Es256;
use Moat\Gate\Crypto\KeyAlgorithm;
use Moat\Gate\Encoding\Base64Url;
use Moat\Gate\Json\JsonObject;
use Moat\Gate\Json\StrictJson;
use Moat\Gate\Rejection;
use Moat\Gate\RejectionCode;

/**
 * Verifies a bundle envelope in the binding order of docs/CRYPTO.md §4.3, steps 1–8: size,
 * envelope, payload decoding, signatures over the exact received bytes, then — only then — JSON,
 * gate id, version and expiry (SEC-01, SEC-03, SEC-04, SEC-05, SEC-07). Throws Rejection with the
 * code of the first failing check.
 */
final class BundleVerifier
{
    public const MAX_ENVELOPE_BYTES = 1024 * 1024;
    public const MAX_SIGNATURES = 16;
    public const MIN_AUTHENTICATOR_DATA = 37;
    public const MAX_AUTHENTICATOR_DATA = 1024;
    public const MAX_CLIENT_DATA_JSON = 2048;
    private const DOMAIN = "moat:bundle:v1\n";

    public static function verify(string $envelopeBytes, VerificationContext $context): VerifiedBundle
    {
        // 1. Size, before anything is parsed.
        if (\strlen($envelopeBytes) > self::MAX_ENVELOPE_BYTES) {
            throw new Rejection(RejectionCode::TooLarge);
        }

        // 2. Envelope: exactly these keys, known type and version.
        try {
            $envelope = StrictJson::decode($envelopeBytes);
        } catch (Rejection) {
            throw new Rejection(RejectionCode::EnvelopeInvalid);
        }
        if (
            !$envelope instanceof JsonObject
            || !$envelope->hasExactKeys('moat', 'v', 'payload', 'sigs')
            || $envelope->get('moat') !== 'bundle'
            || $envelope->get('v') !== 1
        ) {
            throw new Rejection(RejectionCode::EnvelopeInvalid);
        }
        $payload = $envelope->get('payload');
        $entries = $envelope->get('sigs');
        if (!\is_string($payload) || !\is_array($entries) || $entries === [] || \count($entries) > self::MAX_SIGNATURES) {
            throw new Rejection(RejectionCode::EnvelopeInvalid);
        }
        $signatures = [];
        foreach ($entries as $entry) {
            if (!$entry instanceof JsonObject) {
                throw new Rejection(RejectionCode::EnvelopeInvalid);
            }
            $kid = $entry->get('kid');
            $alg = $entry->get('alg');
            if (!\is_string($kid) || !\is_string($alg)) {
                throw new Rejection(RejectionCode::EnvelopeInvalid);
            }
            // docs/CRYPTO.md §4.2: the algorithm decides the exact keys of an entry.
            $passkey = $alg === KeyAlgorithm::WebAuthnEs256->value;
            if (!($passkey ? $entry->hasExactKeys('kid', 'alg', 'sig', 'authenticatorData', 'clientDataJSON') : $entry->hasExactKeys('kid', 'alg', 'sig'))) {
                throw new Rejection(RejectionCode::EnvelopeInvalid);
            }
            $sig = $entry->get('sig');
            $authenticatorData = $entry->get('authenticatorData');
            $clientData = $entry->get('clientDataJSON');
            if (!\is_string($sig) || ($passkey && (!\is_string($authenticatorData) || !\is_string($clientData)))) {
                throw new Rejection(RejectionCode::EnvelopeInvalid);
            }
            $signatures[] = [$kid, $alg, $sig, \is_string($authenticatorData) ? $authenticatorData : '', \is_string($clientData) ? $clientData : ''];
        }

        // 3. Payload bytes — not parsed yet.
        try {
            $payloadBytes = Base64Url::decode($payload);
        } catch (Rejection) {
            throw new Rejection(RejectionCode::PayloadEncoding);
        }

        // 4. Signatures over DOMAIN ‖ payloadBytes. Unknown key ids are ignored; a known key id
        //    with a wrong algorithm or signature rejects the bundle; each key id counts once.
        $message = self::DOMAIN . $payloadBytes;
        $valid = [];
        foreach ($signatures as [$kid, $alg, $sig, $authenticatorData, $clientData]) {
            $signer = self::pinned($context, $kid);
            if ($signer === null) {
                continue;
            }
            if ($alg !== $signer->alg->value) {
                throw new Rejection(RejectionCode::SignatureInvalid);
            }
            if ($signer instanceof PinnedPasskey) {
                self::verifyPasskey($signer, $message, $sig, $authenticatorData, $clientData);
            } else {
                self::verifyEd25519($signer, $message, $sig);
            }
            $valid[$signer->kid] = true;
        }
        if (\count($valid) < max(1, $context->threshold)) {
            throw new Rejection(RejectionCode::ThresholdNotMet);
        }

        // 5. Now the payload is authentic: parse and check its shape.
        try {
            $body = StrictJson::decode($payloadBytes);
        } catch (Rejection) {
            throw new Rejection(RejectionCode::PayloadInvalid);
        }
        $bundle = self::shape($body, $payloadBytes);

        // 6. Bound to this gate (SEC-07).
        if ($bundle->gateId !== $context->gateId) {
            throw new Rejection(RejectionCode::GateMismatch);
        }

        // 7. Monotonic (SEC-04).
        if ($bundle->version <= $context->currentVersion) {
            throw new Rejection(RejectionCode::VersionNotNewer);
        }

        // 8. Optional expiry (SEC-05).
        if ($context->expiryEnabled && $bundle->expiresAt !== null && $bundle->expiresAt <= $context->now) {
            throw new Rejection(RejectionCode::Expired);
        }

        return $bundle;
    }

    private static function verifyEd25519(PinnedSigner $signer, string $message, string $sig): void
    {
        try {
            $signature = Base64Url::decodeLength($sig, SODIUM_CRYPTO_SIGN_BYTES);
        } catch (Rejection) {
            throw new Rejection(RejectionCode::SignatureInvalid);
        }
        $publicKey = $signer->publicKey;
        // Both lengths were checked (64 and 32 bytes); this only tells the type checker.
        if ($signature === '' || $publicKey === '') {
            throw new Rejection(RejectionCode::SignatureInvalid);
        }
        if (!sodium_crypto_sign_verify_detached($signature, $message, $publicKey)) {
            throw new Rejection(RejectionCode::SignatureInvalid);
        }
    }

    /**
     * docs/CRYPTO.md §7.3, steps 2 to 6 (step 1, kid and alg, is done by the caller). Every
     * failure is `signature_invalid`. The sign counter is not used (no state per authenticator;
     * replay is stopped by the monotonic bundle version, SEC-04).
     */
    private static function verifyPasskey(PinnedPasskey $signer, string $message, string $sig, string $authenticatorData, string $clientData): void
    {
        $invalid = new Rejection(RejectionCode::SignatureInvalid);
        // 2. Strict base64url and sizes.
        try {
            $der = Base64Url::decode($sig);
            $auth = Base64Url::decode($authenticatorData);
            $client = Base64Url::decode($clientData);
        } catch (Rejection) {
            throw $invalid;
        }
        if (\strlen($der) > Es256::MAX_DER_BYTES || \strlen($auth) < self::MIN_AUTHENTICATOR_DATA || \strlen($auth) > self::MAX_AUTHENTICATOR_DATA || $client === '' || \strlen($client) > self::MAX_CLIENT_DATA_JSON) {
            throw $invalid;
        }
        // 3. clientDataJSON: more members than we read are fine here and only here.
        try {
            $data = StrictJson::decode($client);
        } catch (Rejection) {
            throw $invalid;
        }
        if (!$data instanceof JsonObject) {
            throw $invalid;
        }
        $origin = $data->get('origin');
        if (
            $data->get('type') !== 'webauthn.get'
            || $data->get('challenge') !== Base64Url::encode(hash('sha256', $message, true))
            || !\is_string($origin) || !\in_array($origin, $signer->origins, true)
            || ($data->has('crossOrigin') && $data->get('crossOrigin') !== false)
        ) {
            throw $invalid;
        }
        // 4. rpIdHash, UP and UV.
        $flags = \ord($auth[32]);
        if (!hash_equals(hash('sha256', $signer->rpId, true), substr($auth, 0, 32)) || ($flags & 0x01) === 0 || ($flags & 0x04) === 0) {
            throw $invalid;
        }
        // 5. and 6. Strict DER, then ECDSA over authenticatorData ‖ SHA-256(clientDataJSON).
        if (!Es256::verify($signer->publicKey, $auth . hash('sha256', $client, true), $der)) {
            throw $invalid;
        }
    }

    private static function pinned(VerificationContext $context, string $kid): PinnedSigner|PinnedPasskey|null
    {
        foreach ($context->signers as $signer) {
            if ($signer->kid === $kid) {
                return $signer;
            }
        }

        return null;
    }

    private static function shape(mixed $body, string $payloadBytes): VerifiedBundle
    {
        if (
            !$body instanceof JsonObject
            || !$body->hasExactKeys('type', 'v', 'gateId', 'version', 'issuedAt', 'expiresAt', 'config', 'secrets')
            || $body->get('type') !== 'moat.bundle'
            || $body->get('v') !== 1
        ) {
            throw new Rejection(RejectionCode::PayloadInvalid);
        }
        $gateId = $body->get('gateId');
        $version = $body->get('version');
        $issuedAt = $body->get('issuedAt');
        $expiresAt = $body->get('expiresAt');
        $config = $body->get('config');
        $secrets = $body->get('secrets');
        if (
            !\is_string($gateId)
            || !\is_int($version) || $version < 1
            || !\is_int($issuedAt)
            || ($expiresAt !== null && !\is_int($expiresAt))
            || !$config instanceof JsonObject
            || !$secrets instanceof JsonObject
        ) {
            throw new Rejection(RejectionCode::PayloadInvalid);
        }

        return new VerifiedBundle($gateId, $version, $issuedAt, $expiresAt, $config, $secrets, $payloadBytes);
    }
}
