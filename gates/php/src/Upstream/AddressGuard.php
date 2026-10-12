<?php

declare(strict_types=1);

namespace Moat\Gate\Upstream;

use Moat\Gate\Http\Failure;
use Moat\Gate\Http\GateError;
use Moat\Gate\Policy\Policy;

/**
 * SEC-41: resolve the upstream host once, refuse it unless every address is public, and hand
 * cURL that one address to connect to (CURLOPT_RESOLVE), so DNS cannot change between the check
 * and the connection. Only the local policy's `testing.resolve` may send a host to loopback.
 */
final class AddressGuard
{
    public static function resolve(string $host, int $port, Policy $policy): string
    {
        $hostKey = $port === 443 ? $host : $host . ':' . $port;
        if (isset($policy->testResolve[$hostKey])) {
            return $policy->testResolve[$hostKey];
        }
        $addresses = gethostbynamel($host);
        $addresses = $addresses === false ? [] : $addresses;
        $records = dns_get_record($host, DNS_AAAA);
        foreach ($records === false ? [] : $records as $record) {
            if (\is_string($record['ipv6'] ?? null)) {
                $addresses[] = $record['ipv6'];
            }
        }
        if ($addresses === []) {
            throw new Failure(GateError::UpstreamUnreachable);
        }
        foreach ($addresses as $address) {
            if (!self::isPublic($address)) {
                throw new Failure(GateError::UpstreamForbidden);
            }
        }

        return $addresses[0];
    }

    /**
     * No private, loopback, link-local, reserved, shared or documentation range — also not when
     * an IPv4 address hides inside IPv6 (NAT64 64:ff9b::/96, 6to4 2002::/16; Teredo is refused).
     */
    public static function isPublic(string $address): bool
    {
        $flags = FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE | FILTER_FLAG_GLOBAL_RANGE;
        if (filter_var($address, FILTER_VALIDATE_IP, ['flags' => $flags]) === false) {
            return false;
        }
        $packed = inet_pton($address);
        if ($packed === false || \strlen($packed) === 4) {
            return $packed !== false;
        }
        $embedded = match (true) {
            str_starts_with($packed, "\x00\x64\xff\x9b" . str_repeat("\x00", 8)) => substr($packed, 12, 4),
            str_starts_with($packed, "\x20\x02") => substr($packed, 2, 4),
            str_starts_with($packed, "\x20\x01\x00\x00") => '',
            default => null,
        };
        if ($embedded === null) {
            return true;
        }
        $ipv4 = $embedded === '' ? false : inet_ntop($embedded);

        return $ipv4 !== false && self::isPublic($ipv4);
    }
}
