<?php

declare(strict_types=1);

namespace Moat\Gate\Runtime;

use Moat\Gate\Config\Limit;
use Moat\Gate\Config\Quota;
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
 */
final class RateLimiter
{
    public const FILE = 'limits';
    private const HEADER = 'moat-limits-v1 ';

    /**
     * @param list<array{string, Limit|Quota}> $counters counter key and its limit
     *
     * @return ?LimitRefusal null when the request may pass
     *
     * @throws \RuntimeException when the store is damaged, full or cannot be written
     */
    public static function hit(DataDir $data, array $counters, int $maxClients, int $now): ?LimitRefusal
    {
        return $data->locked(static function () use ($data, $counters, $maxClients, $now): ?LimitRefusal {
            [$key, $windows] = self::load($data->read(self::FILE), $now);
            $next = [];
            $retryAfter = 0;
            $quota = false;
            foreach ($counters as [$name, $limit]) {
                $id = bin2hex(sodium_crypto_generichash($name, $key, 16));
                $window = $windows[$id] ?? null;
                if ($window === null || $now >= $window[0]) {
                    $next[$id] = [$limit instanceof Quota ? $limit->period->end($now) : $now + $limit->windowSeconds, 1];
                } elseif ($window[1] < $limit->requests) {
                    $next[$id] = [$window[0], $window[1] + 1];
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
            $lines = self::HEADER . bin2hex($key) . "\n";
            foreach ($windows as $id => [$resetAt, $count]) {
                $lines .= $id . ' ' . $resetAt . ' ' . $count . "\n";
            }
            $data->write(self::FILE, $lines);

            return null;
        });
    }

    /**
     * The hash key and the counters still running at `$now` (expired ones dropped).
     *
     * @return array{string, array<string, array{int, int}>}
     */
    private static function load(?string $content, int $now): array
    {
        if ($content === null) {
            return [random_bytes(SODIUM_CRYPTO_GENERICHASH_KEYBYTES), []];
        }
        $lines = explode("\n", $content);
        if (array_pop($lines) !== '' || $lines === [] || preg_match('/^' . self::HEADER . '([0-9a-f]{64})$/D', $lines[0], $match) !== 1) {
            throw new \RuntimeException('rate limit store damaged');
        }
        $key = hex2bin($match[1]);
        if ($key === false) {
            throw new \RuntimeException('rate limit store damaged');
        }
        $windows = [];
        foreach (\array_slice($lines, 1) as $line) {
            if (preg_match('/^([0-9a-f]{32}) ([1-9][0-9]{0,11}) ([1-9][0-9]{0,6})$/D', $line, $match) !== 1) {
                throw new \RuntimeException('rate limit store damaged');
            }
            if ((int) $match[2] > $now) {
                $windows[$match[1]] = [(int) $match[2], (int) $match[3]];
            }
        }

        return [$key, $windows];
    }
}
