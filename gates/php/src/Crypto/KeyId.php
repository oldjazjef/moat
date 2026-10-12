<?php

declare(strict_types=1);

namespace Moat\Gate\Crypto;

use Moat\Gate\Encoding\Base32;
use Moat\Gate\Encoding\Base64Url;

/** Key ids and human fingerprints, docs/CRYPTO.md §3. */
final class KeyId
{
    /** base64url(BLAKE2b-128("moat:kid:v1|" ‖ alg ‖ "|" ‖ publicKey)) */
    public static function of(KeyAlgorithm $alg, string $publicKey): string
    {
        return Base64Url::encode(self::bytes($alg, $publicKey));
    }

    /** `MOAT-` + base32 of the key id in groups of four (SEC-32). */
    public static function fingerprint(KeyAlgorithm $alg, string $publicKey): string
    {
        return 'MOAT-' . implode('-', str_split(Base32::encode(self::bytes($alg, $publicKey)), 4));
    }

    private static function bytes(KeyAlgorithm $alg, string $publicKey): string
    {
        return sodium_crypto_generichash('moat:kid:v1|' . $alg->value . '|' . $publicKey, '', 16);
    }
}
