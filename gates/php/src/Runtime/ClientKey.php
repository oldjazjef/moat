<?php

declare(strict_types=1);

namespace Moat\Gate\Runtime;

/**
 * The client a per-IP limit counts, exactly as clientKey() in libs/core/src/http/rate-limit.ts
 * (conformance/vectors/http/rate-limit.json). Only REMOTE_ADDR is used, never X-Forwarded-For
 * (SEC-26). IPv4 as is; IPv6 by its /64 network, since one host usually owns a whole /64; an
 * IPv4-mapped address as its IPv4 address. Null for anything that is not an IP address.
 */
final class ClientKey
{
    public static function of(string $address): ?string
    {
        if (self::isIPv4($address)) {
            return $address;
        }
        $groups = self::ipv6($address);
        if ($groups === null) {
            return null;
        }
        if ($groups[0] === 0 && $groups[1] === 0 && $groups[2] === 0 && $groups[3] === 0 && $groups[4] === 0 && $groups[5] === 0xFFFF) {
            return implode('.', [$groups[6] >> 8, $groups[6] & 0xFF, $groups[7] >> 8, $groups[7] & 0xFF]);
        }

        return \sprintf('%04x:%04x:%04x:%04x::/64', $groups[0], $groups[1], $groups[2], $groups[3]);
    }

    private static function isIPv4(string $text): bool
    {
        $parts = explode('.', $text);
        if (\count($parts) !== 4) {
            return false;
        }
        foreach ($parts as $part) {
            if (preg_match('/^(?:0|[1-9][0-9]{0,2})$/D', $part) !== 1 || (int) $part > 255) {
                return false;
            }
        }

        return true;
    }

    /** @return ?array{int, int, int, int, int, int, int, int} */
    private static function ipv6(string $text): ?array
    {
        if (preg_match('/^[0-9A-Fa-f:.]{2,45}$/D', $text) !== 1) {
            return null;
        }
        $halves = explode('::', $text);
        if (\count($halves) > 2) {
            return null;
        }
        $head = self::groups($halves[0], \count($halves) === 1);
        $tail = \count($halves) === 2 ? self::groups($halves[1], true) : [];
        if ($head === null || $tail === null) {
            return null;
        }
        if (\count($halves) === 1) {
            $all = $head;
        } else {
            $missing = 8 - \count($head) - \count($tail);
            if ($missing < 1) {
                return null;
            }
            $all = [...$head, ...array_fill(0, $missing, 0), ...$tail];
        }
        if (\count($all) !== 8) {
            return null;
        }

        return [$all[0], $all[1], $all[2], $all[3], $all[4], $all[5], $all[6], $all[7]];
    }

    /** @return ?list<int> */
    private static function groups(string $part, bool $last): ?array
    {
        if ($part === '') {
            return [];
        }
        $out = [];
        $items = explode(':', $part);
        foreach ($items as $index => $item) {
            if ($last && $index === \count($items) - 1 && str_contains($item, '.')) {
                $bytes = explode('.', $item);
                if (!self::isIPv4($item) || \count($bytes) !== 4) {
                    return null;
                }
                $out[] = ((int) $bytes[0] << 8) | (int) $bytes[1];
                $out[] = ((int) $bytes[2] << 8) | (int) $bytes[3];
            } elseif (preg_match('/^[0-9A-Fa-f]{1,4}$/D', $item) === 1) {
                $out[] = (int) hexdec($item);
            } else {
                return null;
            }
        }

        return $out;
    }
}
