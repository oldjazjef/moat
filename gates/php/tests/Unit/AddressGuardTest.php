<?php

declare(strict_types=1);

namespace Moat\Gate\Tests\Unit;

use Moat\Gate\Http\Failure;
use Moat\Gate\Json\StrictJson;
use Moat\Gate\Policy\PolicyCheck;
use Moat\Gate\Upstream\AddressGuard;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/** SEC-41: only public addresses, also when IPv4 hides in IPv6. */
final class AddressGuardTest extends TestCase
{
    /** @return iterable<string, array{string, bool}> */
    public static function addresses(): iterable
    {
        yield 'public IPv4' => ['93.184.216.34', true];
        yield 'public IPv6' => ['2606:4700::1111', true];
        yield 'NAT64 of a public address' => ['64:ff9b::5db8:d822', true];
        yield 'loopback' => ['127.0.0.1', false];
        yield 'private 10/8' => ['10.1.2.3', false];
        yield 'private 192.168/16' => ['192.168.1.1', false];
        yield 'cloud metadata' => ['169.254.169.254', false];
        yield 'shared address space' => ['100.64.0.1', false];
        yield 'unspecified' => ['0.0.0.0', false];
        yield 'documentation' => ['192.0.2.1', false];
        yield 'IPv6 loopback' => ['::1', false];
        yield 'IPv6 link-local' => ['fe80::1', false];
        yield 'IPv6 unique local' => ['fd00::1', false];
        yield 'IPv4-mapped loopback' => ['::ffff:127.0.0.1', false];
        yield 'NAT64 of loopback' => ['64:ff9b::7f00:1', false];
        yield '6to4 of a private address' => ['2002:a00:1::1', false];
        yield 'Teredo' => ['2001:0:4136:e378::1', false];
        yield 'not an address' => ['localhost', false];
        yield 'IPv4 multicast' => ['224.0.0.1', false];
        yield 'IPv4 reserved 240/4' => ['240.0.0.1', false];
        yield 'IPv6 multicast' => ['ff02::1', false];
        yield 'IPv6 site-local' => ['fec0::1', false];
        yield 'local-use NAT64' => ['64:ff9b:1::a00:1', false];
        yield 'SIIT ::ffff:0:0/96' => ['::ffff:0:7f00:1', false];
        yield '6to4 of a public address' => ['2002:5db8:d822::1', true];
        yield 'IPv6 documentation' => ['2001:db8::1', false];
        yield 'broadcast' => ['255.255.255.255', false];
        yield '172.31 private' => ['172.31.255.255', false];
        yield '172.32 public' => ['172.32.0.1', true];
        yield 'benchmarking' => ['198.19.0.1', false];
    }

    #[DataProvider('addresses')]
    public function testSec41PublicAddressesOnly(string $address, bool $public): void
    {
        self::assertSame($public, AddressGuard::isPublic($address));
    }

    public function testSec41LoopbackOnlyThroughTheLocalPolicysTestingBlock(): void
    {
        $policy = PolicyCheck::parse(StrictJson::decode(
            '{"v":1,"upstreams":{},"maxBodyBytes":0,"maxResponseBytes":1,"maxTimeoutMs":1,'
            . '"testing":{"resolve":{"upstream.test:8443":"127.0.0.1"},"caFile":null}}',
        ));
        self::assertSame('127.0.0.1', AddressGuard::resolve('upstream.test', 8443, $policy));

        $this->expectException(Failure::class);
        AddressGuard::resolve('localhost', 8443, $policy);
    }
}
