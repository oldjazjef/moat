<?php

declare(strict_types=1);

namespace Moat\Gate\Runtime;

use Moat\Gate\Config\Limit;
use Moat\Gate\Config\Quota;
use Moat\Gate\Config\Route;
use Moat\Gate\Storage\DataDir;

/**
 * FR-30, FR-31, SEC-45: rate limits and quotas counted on the gate, as hitLimits() in
 * libs/core/src/http/rate-limit.ts (conformance/vectors/http/rate-limit.json). A rate-limit window
 * opens with the first request and lasts `windowSeconds`; a quota's window is the calendar day or
 * month (UTC) of the request; a refused request does not count; a request passes only if every
 * limit has room, and then every counter is raised.
 *
 * The counters live in one guarded data file, read and replaced under an exclusive lock. Keys are
 * keyed BLAKE2b hashes (with a random key kept in the file), so the file holds no IP address
 * (SEC-47). It holds at most `$maxClients` counters: expired ones are dropped first, and when it is
 * still full a new client is refused (SEC-27, fail closed). A damaged file refuses everything.
 *
 * A route's counters (its rate limit and quota) belong to the route limits of the bundle in force,
 * named by `$routeLimits` (a hash of them): when those change, the old route counters are dropped,
 * so the counters of earlier bundles — up to a month for a quota — cannot fill the store
 * (SEC-27). The policy's counters stay whatever the bundle does.
 */
final class RateLimiter
{
    public const FILE = 'limits';
    /** For callers with no route counters (tests, a gate without route limits). */
    public const NO_ROUTE_LIMITS = '00000000000000000000000000000000';
    private const HEADER = 'moat-limits-v2 ';
    /** The format before quotas: its counters are dropped once, on the first request after an update. */
    private const HEADER_V1 = 'moat-limits-v1 ';

    /**
     * @param list<array{0: string, 1: Limit|Quota, 2?: bool}> $counters counter key, its limit,
     *        and true for a route's counter (dropped when `$routeLimits` changes)
     * @param string $routeLimits 32 hex digits naming the bundle's route limits
     *
     * @return ?LimitRefusal null when the request may pass
     *
     * @throws \RuntimeException when the store is damaged, full or cannot be written
     */
    public static function hit(DataDir $data, array $counters, int $maxClients, int $now, string $routeLimits = self::NO_ROUTE_LIMITS): ?LimitRefusal
    {
        if (preg_match('/^[0-9a-f]{32}$/D', $routeLimits) !== 1) {
            throw new \InvalidArgumentException('route limits id');
        }

        return $data->locked(static function () use ($data, $counters, $maxClients, $now, $routeLimits): ?LimitRefusal {
            [$key, $windows] = self::load($data->read(self::FILE), $now, $routeLimits);
            $next = [];
            $retryAfter = 0;
            $quota = false;
            foreach ($counters as $counter) {
                [$name, $limit] = $counter;
                $route = $counter[2] ?? false;
                $id = bin2hex(sodium_crypto_generichash($name, $key, 16));
                $window = $windows[$id] ?? null;
                if ($window === null || $now >= $window[0]) {
                    $next[$id] = [$limit instanceof Quota ? $limit->period->end($now) : $now + $limit->windowSeconds, 1, $route];
                } elseif ($window[1] < $limit->requests) {
                    $next[$id] = [$window[0], $window[1] + 1, $route];
                } else {
                    $retryAfter = max($retryAfter, $window[0] - $now);
                    $quota = $quota || $limit instanceof Quota;
                }
            }
            if ($retryAfter > 0) {
                return new LimitRefusal($retryAfter, $quota);
            }
            $windows = $next + $windows;
            if (\count($windows) > $maxClients) {
                throw new \RuntimeException('rate limit store full');
            }
            $lines = self::HEADER . bin2hex($key) . ' ' . $routeLimits . "\n";
            foreach ($windows as $id => [$resetAt, $count, $route]) {
                $lines .= $id . ' ' . $resetAt . ' ' . $count . ' ' . ($route ? 'r' : 'g') . "\n";
            }
            $data->write(self::FILE, $lines);

            return null;
        });
    }

    /**
     * The id of a bundle's route limits: every route's name, rate limit and quota. A bundle that
     * changes none of them keeps the route counters running.
     *
     * @param array<string, Route> $routes
     */
    public static function routeLimitsId(array $routes): string
    {
        ksort($routes, SORT_STRING);
        $text = '';
        foreach ($routes as $name => $route) {
            $limit = $route->rateLimit;
            $quota = $route->quota;
            $text .= $name . ' '
                . ($limit === null ? '-' : $limit->limit->requests . '/' . $limit->limit->windowSeconds . '/' . $limit->per->value) . ' '
                . ($quota === null ? '-' : $quota->requests . '/' . $quota->period->value) . "\n";
        }

        return bin2hex(sodium_crypto_generichash($text, '', 16));
    }

    /**
     * The hash key and the counters still running at `$now` (expired ones dropped, and route
     * counters of other route limits than `$routeLimits`).
     *
     * @return array{string, array<string, array{int, int, bool}>}
     */
    private static function load(?string $content, int $now, string $routeLimits): array
    {
        if ($content === null) {
            return [random_bytes(SODIUM_CRYPTO_GENERICHASH_KEYBYTES), []];
        }
        $lines = explode("\n", $content);
        if (array_pop($lines) !== '' || $lines === []) {
            throw new \RuntimeException('rate limit store damaged');
        }
        if (preg_match('/^' . self::HEADER_V1 . '[0-9a-f]{64}$/D', $lines[0]) === 1) {
            return [random_bytes(SODIUM_CRYPTO_GENERICHASH_KEYBYTES), []];
        }
        if (preg_match('/^' . self::HEADER . '([0-9a-f]{64}) ([0-9a-f]{32})$/D', $lines[0], $match) !== 1) {
            throw new \RuntimeException('rate limit store damaged');
        }
        $key = hex2bin($match[1]);
        if ($key === false) {
            throw new \RuntimeException('rate limit store damaged');
        }
        $sameRoutes = hash_equals($match[2], $routeLimits);
        $windows = [];
        foreach (\array_slice($lines, 1) as $line) {
            if (preg_match('/^([0-9a-f]{32}) ([1-9][0-9]{0,11}) ([1-9][0-9]{0,6}) ([rg])$/D', $line, $match) !== 1) {
                throw new \RuntimeException('rate limit store damaged');
            }
            $route = $match[4] === 'r';
            if ((int) $match[2] > $now && ($sameRoutes || !$route)) {
                $windows[$match[1]] = [(int) $match[2], (int) $match[3], $route];
            }
        }

        return [$key, $windows];
    }
}
