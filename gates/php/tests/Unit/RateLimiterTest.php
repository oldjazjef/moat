<?php

declare(strict_types=1);

namespace Moat\Gate\Tests\Unit;

use Moat\Gate\Config\Limit;
use Moat\Gate\Config\Method;
use Moat\Gate\Config\Quota;
use Moat\Gate\Config\QuotaPeriod;
use Moat\Gate\Config\Route;
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

    public function testSec27RouteCountersOfEarlierRouteLimitsCannotFillTheStore(): void
    {
        // A month-long quota counter per route, for routes of bundles no longer in force: a
        // compromised Cloud renaming routes bundle after bundle must not fill the store.
        $month = new Quota(1, QuotaPeriod::Month);
        $total = new Limit(1000, 60);
        $old = str_repeat('a', 32);
        for ($i = 0; $i < 99; ++$i) {
            self::assertNull(RateLimiter::hit($this->data, [['total', $total], ['quota route r' . $i . ' month', $month, true]], 100, 1000, $old));
        }
        try {
            RateLimiter::hit($this->data, [['total', $total], ['quota route x month', $month, true]], 100, 1000, $old);
            self::fail('the store is full under the same route limits');
        } catch (\RuntimeException $e) {
            self::assertSame('rate limit store full', $e->getMessage());
        }
        $new = str_repeat('b', 32);
        self::assertNull(RateLimiter::hit($this->data, [['total', $total], ['quota route x month', $month, true]], 100, 1000, $new));
        // The policy's counters survive the change: `total` still counts the earlier requests.
        $refusal = RateLimiter::hit($this->data, [['total', new Limit(100, 60)]], 100, 1000, $new);
        self::assertNotNull($refusal);
        self::assertFalse($refusal->quota);
    }

    public function testAStoreFromBeforeQuotasStartsAfreshInsteadOfRefusing(): void
    {
        $this->data->write(RateLimiter::FILE, 'moat-limits-v1 ' . str_repeat('ab', 32) . "\n" . str_repeat('c', 32) . " 2000 5\n");
        self::assertNull(RateLimiter::hit($this->data, [['total', new Limit(1, 60)]], 100, 1000));
        self::assertStringStartsWith('moat-limits-v2 ', (string) $this->data->read(RateLimiter::FILE));
    }

    public function testRouteLimitsIdChangesOnlyWithARouteLimit(): void
    {
        $route = static fn(?Quota $quota, string $path = '/a'): Route => new Route('a', Method::Post, $path, 'u', '/x', 0, ['application/json'], ['application/json'], true, [], null, $quota);
        $day = RateLimiter::routeLimitsId(['a' => $route(new Quota(5, QuotaPeriod::Day))]);
        self::assertSame($day, RateLimiter::routeLimitsId(['a' => $route(new Quota(5, QuotaPeriod::Day), '/b')]));
        self::assertNotSame($day, RateLimiter::routeLimitsId(['a' => $route(new Quota(5, QuotaPeriod::Month))]));
        self::assertNotSame($day, RateLimiter::routeLimitsId(['a' => $route(null)]));
        self::assertMatchesRegularExpression('/^[0-9a-f]{32}$/D', $day);
    }

    public function testSec46ADamagedStoreRefusesEverything(): void
    {
        $limit = new Limit(10, 60);
        RateLimiter::hit($this->data, [['total', $limit]], 100, 1000);
        $this->data->write(RateLimiter::FILE, "moat-limits-v2 zz\n");
        $this->expectException(\RuntimeException::class);
        RateLimiter::hit($this->data, [['total', $limit]], 100, 1000);
    }

    public function testSec47TheStoreHoldsNoAddressOrRouteName(): void
    {
        RateLimiter::hit($this->data, [['ip 203.0.113.77', new Limit(5, 60)], ['route newsletter 203.0.113.77', new Limit(5, 60)]], 100, 1000);
        $content = (string) $this->data->read(RateLimiter::FILE);
        self::assertStringNotContainsString('203.0.113.77', $content);
        self::assertStringNotContainsString('newsletter', $content);
        self::assertStringStartsWith('moat-limits-v2 ', $content);
    }

    public function testSec45TheTotalLimitStopsEveryClient(): void
    {
        $total = new Limit(3, 60);
        $perIp = new Limit(100, 60);
        foreach (['a', 'b', 'c'] as $client) {
            self::assertNull(RateLimiter::hit($this->data, [['ip ' . $client, $perIp], ['total', $total]], 100, 1000));
        }
        self::assertSame(60, RateLimiter::hit($this->data, [['ip d', $perIp], ['total', $total]], 100, 1000)?->retryAfter);
    }

    public function testTheStoreFileIsGuardedOnH1(): void
    {
        RateLimiter::hit($this->data, [['total', new Limit(1, 60)]], 100, 1000);
        foreach (['limits.php', 'lock.php'] as $file) {
            self::assertStringStartsWith(DataDir::MARKER . "\n", (string) file_get_contents($this->data->path . '/' . $file));
        }
    }

    public function testABusyLockFailsInsteadOfQueueingEveryWorker(): void
    {
        $handle = fopen($this->data->path . '/lock.php', 'cb');
        self::assertNotFalse($handle);
        flock($handle, LOCK_EX);
        try {
            $start = microtime(true);
            RateLimiter::hit($this->data, [['total', new Limit(1, 60)]], 100, 1000);
            self::fail('a held lock must not be waited on forever');
        } catch (\RuntimeException $e) {
            self::assertSame('lock busy', $e->getMessage());
            self::assertLessThan(2.0, microtime(true) - $start);
        } finally {
            flock($handle, LOCK_UN);
            fclose($handle);
        }
    }
}
