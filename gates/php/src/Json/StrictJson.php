<?php

declare(strict_types=1);

namespace Moat\Gate\Json;

use Moat\Gate\Rejection;
use Moat\Gate\RejectionCode;

/**
 * Parses JSON exactly as libs/core does (docs/CRYPTO.md §2, conformance/vectors/crypto/json.json):
 * strict UTF-8 without BOM, integers 0 … 2^53 − 1 only (no fraction, no exponent; -0 is 0), no
 * lone surrogates, no key starting with NUL, at most 32 nested containers. Objects become
 * JsonObject, arrays lists. Anything else → `json_invalid`.
 */
final class StrictJson
{
    public const MAX_DEPTH = 32;
    private const MAX_INTEGER = 9007199254740991;

    public static function decode(string $bytes): mixed
    {
        try {
            // json_decode counts the scalar level too: depth 33 = 32 containers.
            $value = json_decode($bytes, false, self::MAX_DEPTH + 1, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new Rejection(RejectionCode::JsonInvalid);
        }

        return self::normalise($value);
    }

    private static function normalise(mixed $value): mixed
    {
        if ($value === null || \is_bool($value) || \is_string($value)) {
            return $value;
        }
        if (\is_int($value)) {
            if ($value < 0 || $value > self::MAX_INTEGER) {
                throw new Rejection(RejectionCode::JsonInvalid);
            }

            return $value;
        }
        if (\is_array($value)) {
            return array_map(self::normalise(...), array_values($value));
        }
        if ($value instanceof \stdClass) {
            $members = [];
            foreach (get_object_vars($value) as $key => $member) {
                $members[(string) $key] = self::normalise($member);
            }

            return new JsonObject($members);
        }

        // Floats (fractions, exponents and integers too large for PHP) and anything else.
        throw new Rejection(RejectionCode::JsonInvalid);
    }
}
