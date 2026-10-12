<?php

declare(strict_types=1);

namespace Moat\Gate\Http;

use Moat\Gate\Rejection;
use Moat\Gate\RejectionCode;

/**
 * SEC-42: the raw request path → the one form routes are matched against, exactly as libs/core
 * does it (conformance/vectors/http/path.json). Only escapes of unreserved characters are
 * decoded; no empty, "." or ".." segment; only RFC 3986 path characters.
 */
final class PathNormaliser
{
    public const MAX_LENGTH = 2048;

    public static function normalise(string $raw): string
    {
        $length = \strlen($raw);
        if ($length === 0 || $length > self::MAX_LENGTH || $raw[0] !== '/') {
            throw new Rejection(RejectionCode::PathInvalid);
        }
        $out = '';
        for ($index = 0; $index < $length; $index++) {
            $char = $raw[$index];
            if ($char !== '%') {
                $out .= $char;
                continue;
            }
            $hex = substr($raw, $index + 1, 2);
            if (preg_match('/^[0-9A-Fa-f]{2}$/D', $hex) !== 1) {
                throw new Rejection(RejectionCode::PathInvalid);
            }
            $decoded = \chr((int) hexdec($hex));
            if (preg_match('/^[A-Za-z0-9\-._~]$/D', $decoded) !== 1) {
                throw new Rejection(RejectionCode::PathInvalid);
            }
            $out .= $decoded;
            $index += 2;
        }
        if (preg_match("~^[A-Za-z0-9\\-._\\~!$&'()*+,;=:@/]*$~D", $out) !== 1) {
            throw new Rejection(RejectionCode::PathInvalid);
        }
        $segments = \array_slice(explode('/', $out), 1);
        $last = \count($segments) - 1;
        foreach ($segments as $position => $segment) {
            if ($segment === '.' || $segment === '..' || ($segment === '' && $position !== $last)) {
                throw new Rejection(RejectionCode::PathInvalid);
            }
        }

        return $out;
    }

    /** A path as routes and upstream paths are written: already normalised, no trailing "/". */
    public static function isRoutePath(string $value): bool
    {
        try {
            return self::normalise($value) === $value && ($value === '/' || !str_ends_with($value, '/'));
        } catch (Rejection) {
            return false;
        }
    }
}
