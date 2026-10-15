<?php

declare(strict_types=1);

namespace Moat\Gate\Crypto;

/**
 * Trust mode 2, passkeys (docs/CRYPTO.md §7): the grammar of `rpId` and origins, the strict DER of
 * an ECDSA signature, and the one place where `ext-openssl` is used — `openssl_verify` over
 * ECDSA P-256 with SHA-256, with the key built from the pinned 65-byte point. Nothing else in
 * the gate touches OpenSSL.
 */
final class Es256
{
    public const POINT_BYTES = 65;
    public const MAX_DER_BYTES = 80;
    public const MAX_ORIGIN_BYTES = 300;

    private const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
    /** The group order n of P-256, big-endian. */
    private const ORDER_HEX = 'ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551';
    /** SubjectPublicKeyInfo header of an uncompressed P-256 key (id-ecPublicKey, prime256v1). */
    private const SPKI_HEADER_HEX = '3059301306072a8648ce3d020106082a8648ce3d030107034200';

    /** docs/CRYPTO.md §7.1: a lower-case DNS name of 1 to 253 characters, no IP address. */
    public static function isRpId(string $value): bool
    {
        return self::isDnsName($value);
    }

    /** docs/CRYPTO.md §7.1: `https://<dns-name>[:<port>]` (port not 443) or `app://<name>`. */
    public static function isOrigin(string $value): bool
    {
        if (\strlen($value) > self::MAX_ORIGIN_BYTES) {
            return false;
        }
        if (str_starts_with($value, 'app://')) {
            return preg_match('/^[a-z][a-z0-9-]{0,62}$/D', substr($value, 6)) === 1;
        }
        if (preg_match('/^https:\/\/([^:\/]+)(?::([1-9][0-9]{0,4}))?$/D', $value, $match) !== 1 || !self::isDnsName($match[1])) {
            return false;
        }
        $port = $match[2] ?? null;

        return $port === null || ((int) $port <= 65535 && $port !== '443');
    }

    /**
     * docs/CRYPTO.md §7.3 step 5: `SEQUENCE { INTEGER r, INTEGER s }` in short-form lengths,
     * minimal and positive integers, nothing after it, and 1 ≤ r, s ≤ n − 1. Low-S is not required.
     */
    public static function isStrictDer(string $der): bool
    {
        $length = \strlen($der);
        if ($length < 8 || $length > self::MAX_DER_BYTES || $der[0] !== "\x30" || \ord($der[1]) >= 0x80 || \ord($der[1]) !== $length - 2) {
            return false;
        }
        $r = self::integerAt($der, 2);
        $s = $r === null ? null : self::integerAt($der, $r[1]);
        if ($r === null || $s === null || $s[1] !== $length) {
            return false;
        }
        $order = (string) hex2bin(self::ORDER_HEX);
        foreach ([$r[0], $s[0]] as $part) {
            if ($part === str_repeat("\0", 32) || strcmp($part, $order) >= 0) {
                return false;
            }
        }

        return true;
    }

    /**
     * ECDSA P-256 / SHA-256 over `$data` with the uncompressed point; false for anything that is
     * not a valid signature, including a point off the curve, a missing extension or an OpenSSL
     * error (fail closed).
     */
    public static function verify(string $point, string $data, string $der): bool
    {
        if (!\extension_loaded('openssl') || \strlen($point) !== self::POINT_BYTES || $point[0] !== "\x04" || !self::isStrictDer($der)) {
            return false;
        }
        $pem = self::pem($point);
        try {
            $key = openssl_pkey_get_public($pem);
            $valid = $key !== false && openssl_verify($data, $der, $key, OPENSSL_ALGO_SHA256) === 1;
        } catch (\Throwable) {
            $valid = false;
        }
        // Do not leave OpenSSL's error queue for the next caller's message.
        while (openssl_error_string() !== false) {
            // drained
        }

        return $valid;
    }

    /** True when `$point` is a point on P-256 (`trust --passkey` checks it when pinning). */
    public static function isOnCurve(string $point): bool
    {
        if (!\extension_loaded('openssl') || \strlen($point) !== self::POINT_BYTES || $point[0] !== "\x04") {
            return false;
        }
        $pem = self::pem($point);
        try {
            $valid = openssl_pkey_get_public($pem) !== false;
        } catch (\Throwable) {
            $valid = false;
        }
        while (openssl_error_string() !== false) {
            // drained
        }

        return $valid;
    }

    private static function pem(string $point): string
    {
        return "-----BEGIN PUBLIC KEY-----\n"
            . chunk_split(base64_encode((string) hex2bin(self::SPKI_HEADER_HEX) . $point), 64, "\n")
            . "-----END PUBLIC KEY-----\n";
    }

    private static function isDnsName(string $value): bool
    {
        return \strlen($value) <= 253
            && preg_match('/^' . self::LABEL . '(?:\.' . self::LABEL . ')*$/D', $value) === 1
            && preg_match('/^[0-9.]+$/D', $value) !== 1;
    }

    /** @return array{string, int}|null the 32-byte value and the next offset */
    private static function integerAt(string $der, int $at): ?array
    {
        if ($at + 1 >= \strlen($der) || $der[$at] !== "\x02") {
            return null;
        }
        $length = \ord($der[$at + 1]);
        $start = $at + 2;
        if ($length < 1 || $length > 33 || $start + $length > \strlen($der)) {
            return null;
        }
        $body = substr($der, $start, $length);
        $first = \ord($body[0]);
        if ($first >= 0x80 || ($length > 1 && $first === 0 && \ord($body[1]) < 0x80)) {
            return null; // negative, or not minimal
        }
        if ($first === 0) {
            $body = substr($body, 1);
        }
        if (\strlen($body) > 32) {
            return null;
        }

        return [str_pad($body, 32, "\0", STR_PAD_LEFT), $start + $length];
    }
}
