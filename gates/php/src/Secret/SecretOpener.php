<?php

declare(strict_types=1);

namespace Moat\Gate\Secret;

use Moat\Gate\Encoding\Base64Url;
use Moat\Gate\Json\JsonObject;
use Moat\Gate\Rejection;
use Moat\Gate\RejectionCode;

/**
 * Opens a sealed secret with the gate's own X25519 key (docs/CRYPTO.md §5). Gate id and secret
 * name come from the gate — its own id and the name the secret is stored under — never from the
 * sealed object, so a ciphertext copied to another gate or name fails (SEC-33). Every failure is
 * `secret_invalid`. The caller wipes the returned plaintext with sodium_memzero after use.
 */
final class SecretOpener
{
    public const ALG = 'x25519-blake2b-xchacha20poly1305';
    private const DOMAIN = 'moat:secret:v1';

    public static function open(mixed $sealed, string $gateSecretKey, string $gateId, string $secretName): string
    {
        if (
            !$sealed instanceof JsonObject
            || !$sealed->hasExactKeys('v', 'alg', 'secretVersion', 'epk', 'nonce', 'ct')
            || $sealed->get('v') !== 1
            || $sealed->get('alg') !== self::ALG
        ) {
            throw new Rejection(RejectionCode::SecretInvalid);
        }
        $secretVersion = $sealed->get('secretVersion');
        if (!\is_int($secretVersion) || $secretVersion < 1) {
            throw new Rejection(RejectionCode::SecretInvalid);
        }

        $shared = '';
        $key = '';
        try {
            $epk = Base64Url::decodeLength($sealed->get('epk'), SODIUM_CRYPTO_BOX_PUBLICKEYBYTES);
            $nonce = Base64Url::decodeLength($sealed->get('nonce'), SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_NPUBBYTES);
            $ct = Base64Url::decode($sealed->get('ct'));
            $gatePublicKey = sodium_crypto_scalarmult_base($gateSecretKey);
            // Throws for an all-zero result (low-order or zero epk); checked again below.
            $shared = sodium_crypto_scalarmult($gateSecretKey, $epk);
            if (hash_equals(str_repeat("\0", SODIUM_CRYPTO_SCALARMULT_BYTES), $shared)) {
                throw new Rejection(RejectionCode::SecretInvalid);
            }
            $key = sodium_crypto_generichash(self::DOMAIN . $epk . $gatePublicKey, $shared, 32);
            $ad = self::DOMAIN . '|' . $gateId . '|' . $secretName . '|' . $secretVersion;
            $plaintext = sodium_crypto_aead_xchacha20poly1305_ietf_decrypt($ct, $ad, $nonce, $key);
        } catch (Rejection | \SodiumException) {
            throw new Rejection(RejectionCode::SecretInvalid);
        } finally {
            sodium_memzero($shared);
            sodium_memzero($key);
        }
        if ($plaintext === false) {
            throw new Rejection(RejectionCode::SecretInvalid);
        }

        return $plaintext;
    }
}
