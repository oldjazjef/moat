<?php

declare(strict_types=1);

namespace Moat\Gate\Tests\Unit;

use Moat\Gate\Config\Limit;
use Moat\Gate\Runtime\RateLimiter;
use Moat\Gate\Storage\DataDir;
use PHPUnit\Framework\TestCase;

/** The counter store behind FR-30 / SEC-45, attacked: flooding, tampering, reading it. */
final class RateLimiterTest extends TestCase
{
    private DataDir $data;

    protected function setUp(): void
    {
        $dir = sys_get_temp_dir() . '/moat-limiter-' . bin2hex(random_bytes(6));
        mkdir($dir, 0o700);
        $this->data = DataDir::create($dir);
    }

    public function testSec27AFullStoreRefusesNewClientsButKeepsCountingKnownOnes(): void
    {
        $limit = new Limit(10, 60);
        for ($i = 0; $i < 100; ++$i) {
            self::assertNull(RateLimiter::hit($this->data, [['ip 198.51.100.' . $i, $limit]], 100, 1000));
        }
        try {
            RateLimiter::hit($this->data, [['ip 203.0.113.1', $limit]], 100, 1000);
            self::fail('a client beyond maxClients must be refused');
        } catch (\RuntimeException $e) {
            self::assertSame('rate limit store full', $e->getMessage());
        }
        self::assertNull(RateLimiter::hit($this->data, [['ip 198.51.100.7', $limit]], 100, 1000));
    }

    public function testSec27ExpiredCountersMakeRoomAgain(): void
    {
        $limit = new Limit(10, 60);
        for ($i = 0; $i < 100; ++$i) {
            RateLimiter::hit($this->data, [['ip 198.51.100.' . $i, $limit]], 100, 1000);
        }
        self::assertNull(RateLimiter::hit($this->data, [['ip 203.0.113.1', $limit]], 100, 1060));
    }

    public function testSec46ADamagedStoreRefusesEverything(): void
    {
        $limit = new Limit(10, 60);
        RateLimiter::hit($this->data, [['total', $limit]], 100, 1000);
        $this->data->write(RateLimiter::FILE, "moat-limits-v1 zz\n");
        $this->expectException(\RuntimeException::class);
        RateLimiter::hit($this->data, [['total', $limit]], 100, 1000);
    }

    public function testSec47TheStoreHoldsNoAddressOrRouteName(): void
    {
        RateLimiter::hit($this->data, [['ip 203.0.113.77', new Limit(5, 60)], ['route newsletter 203.0.113.77', new Limit(5, 60)]], 100, 1000);
        $content = (string) $this->data->read(RateLimiter::FILE);
        self::assertStringNotContainsString('203.0.113.77', $content);
        self::assertStringNotContainsString('newsletter', $content);
        self::assertStringStartsWith('moat-limits-v1 ', $content);
    }

    public function testSec45TheTotalLimitStopsEveryClient(): void
    {
        $total = new Limit(3, 60);
        $perIp = new Limit(100, 60);
        foreach (['a', 'b', 'c'] as $client) {
            self::assertNull(RateLimiter::hit($this->data, [['ip ' . $client, $perIp], ['total', $total]], 100, 1000));
        }
        self::assertSame(60, RateLimiter::hit($this->data, [['ip d', $perIp], ['total', $total]], 100, 1000));
    }

    public function testTheStoreFileIsGuardedOnH1(): void
    {
        RateLimiter::hit($this->data, [['total', new Limit(1, 60)]], 100, 1000);
        foreach (['limits.php', 'lock.php'] as $file) {
            self::assertStringStartsWith(DataDir::MARKER . "\n", (string) file_get_contents($this->data->path . '/' . $file));
        }
    }
}
