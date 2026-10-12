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

    /** IPv4 ranges that are not public (RFC 6890 and friends). */
    private const IPV4_BLOCKED = [
        ['0.0.0.0', 8],
        ['10.0.0.0', 8],
        ['100.64.0.0', 10],
        ['127.0.0.0', 8],
        ['169.254.0.0', 16],
        ['172.16.0.0', 12],
        ['192.0.0.0', 24],
        ['192.0.2.0', 24],
        ['192.88.99.0', 24],
        ['192.168.0.0', 16],
        ['198.18.0.0', 15],
        ['198.51.100.0', 24],
        ['203.0.113.0', 24],
        ['224.0.0.0', 4],
        ['240.0.0.0', 4],
    ];

    /** Inside global unicast 2000::/3: IETF assignments (Teredo, benchmarking, ORCHID) and documentation. */
    private const IPV6_BLOCKED = [
        ['2001::', 23],
        ['2001:db8::', 32],
        ['3fff::', 20],
    ];

    /**
     * Public addresses only. IPv6 must be global unicast (2000::/3); an IPv4 address hidden inside
     * IPv6 is checked as IPv4 (NAT64 64:ff9b::/96, 6to4 2002::/16). Mapped, local, link-local,
     * site-local, multicast and every other range are refused.
     */
    public static function isPublic(string $address): bool
    {
        $packed = inet_pton($address);
        if ($packed === false) {
            return false;
        }
        if (\strlen($packed) === 4) {
            return !self::inAny($packed, self::IPV4_BLOCKED);
        }
        if (str_starts_with($packed, "\x00\x64\xff\x9b" . str_repeat("\x00", 8))) {
            return self::isPublic((string) inet_ntop(substr($packed, 12, 4)));
        }
        if ((\ord($packed[0]) & 0xE0) !== 0x20 || self::inAny($packed, self::IPV6_BLOCKED)) {
            return false;
        }
        if (str_starts_with($packed, "\x20\x02")) {
            return self::isPublic((string) inet_ntop(substr($packed, 2, 4)));
        }

        return true;
    }

    /** @param list<array{string, int}> $ranges CIDR blocks (address, prefix length) */
    private static function inAny(string $packed, array $ranges): bool
    {
        foreach ($ranges as [$base, $bits]) {
            $network = inet_pton($base);
            if ($network === false || \strlen($network) !== \strlen($packed)) {
                continue;
            }
            $bytes = intdiv($bits, 8);
            $rest = $bits % 8;
            if (substr($packed, 0, $bytes) !== substr($network, 0, $bytes)) {
                continue;
            }
            $mask = (0xFF << (8 - $rest)) & 0xFF;
            if ($rest === 0 || (\ord($packed[$bytes]) & $mask) === (\ord($network[$bytes]) & $mask)) {
                return true;
            }
        }

        return false;
    }
}
