<?php

declare(strict_types=1);

namespace Moat\Gate\Encoding;

use Moat\Gate\Rejection;
use Moat\Gate\RejectionCode;

/**
 * base64url without padding (RFC 4648 §5), docs/CRYPTO.md §2. Decoding is strict: padding, the
 * standard alphabet, whitespace, impossible lengths and non-zero trailing bits are rejected, so
 * every byte string has exactly one accepted encoding.
 */
final class Base64Url
{
    public static function encode(string $bytes): string
    {
        return sodium_bin2base64($bytes, SODIUM_BASE64_VARIANT_URLSAFE_NO_PADDING);
    }

    public static function decode(mixed $text): string
    {
        if (!\is_string($text)) {
            throw new Rejection(RejectionCode::EncodingInvalid);
        }
        try {
            $bytes = sodium_base642bin($text, SODIUM_BASE64_VARIANT_URLSAFE_NO_PADDING);
        } catch (\SodiumException) {
            throw new Rejection(RejectionCode::EncodingInvalid);
        }
        // Belt and braces: only the canonical encoding is accepted, whatever libsodium tolerates.
        if (self::encode($bytes) !== $text) {
            throw new Rejection(RejectionCode::EncodingInvalid);
        }

        return $bytes;
    }

    /** Decodes and checks the exact byte length (keys, nonces, signatures). */
    public static function decodeLength(mixed $text, int $length): string
    {
        $bytes = self::decode($text);
        if (\strlen($bytes) !== $length) {
            throw new Rejection(RejectionCode::EncodingInvalid);
        }

        return $bytes;
    }
}
