<?php

declare(strict_types=1);

namespace Moat\Gate\Http;

/** FR-18: media types, as in libs/core (conformance/vectors/http/content-type.json). */
final class ContentType
{
    public const MEDIA_TYPE = '~^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$~D';

    /** `Application/JSON; charset=utf-8` → `application/json`; null when malformed. */
    public static function mediaTypeOf(string $header): ?string
    {
        $raw = trim(explode(';', $header, 2)[0], " \t");
        if (preg_match('/^[\x21-\x7e]*$/D', $raw) !== 1) {
            return null;
        }
        $type = strtolower($raw);

        return preg_match(self::MEDIA_TYPE, $type) === 1 ? $type : null;
    }

    /** @param list<string> $allowed */
    public static function isAllowed(string $header, array $allowed): bool
    {
        $type = self::mediaTypeOf($header);

        return $type !== null && \in_array($type, $allowed, true);
    }
}
