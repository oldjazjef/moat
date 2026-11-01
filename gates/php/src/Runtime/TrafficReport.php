<?php

declare(strict_types=1);

namespace Moat\Gate\Runtime;

use Moat\Gate\Json\JsonObject;
use Moat\Gate\Json\StrictJson;
use Moat\Gate\Rejection;

/**
 * The traffic report (FR-50, FR-51, T-110; libs/core gate/traffic-report.ts,
 * conformance/vectors/gate/traffic-report.json): sums per route and complete UTC hour from the
 * request log — requests, status classes, the gate's error codes and the duration. No client hash,
 * no single request, no path, no address.
 */
final class TrafficReport
{
    public const HOUR = 3600;
    public const LOOKBACK_HOURS = 24;
    public const MAX_BUCKETS = 500;
    public const MAX_ERROR_CODES = 20;

    /**
     * What to send now, and the cursor once the place took it; the report is null when no hour
     * is complete since `$sentUntil` (null = never sent).
     *
     * @param list<array{t: int, route: ?string, status: int, error: ?string, ms: int}> $entries
     *
     * @return array{?array{v: int, gateId: string, hours: list<array<string, mixed>>}, int}
     */
    public static function build(string $gateId, array $entries, ?int $sentUntil, int $now): array
    {
        $current = intdiv($now, self::HOUR) * self::HOUR;
        $floor = $current - self::LOOKBACK_HOURS * self::HOUR;
        $from = ($sentUntil === null || $sentUntil < $floor || $sentUntil > $current) ? $floor : $sentUntil;
        if ($from >= $current) {
            return [null, $from];
        }
        /** @var array<string, array{hour: int, route: ?string, requests: int, s2: int, s3: int, s4: int, s5: int, errors: array<string, int>, msTotal: int, msMax: int}> $buckets */
        $buckets = [];
        foreach ($entries as $entry) {
            if ($entry['t'] < $from || $entry['t'] >= $current || $entry['status'] < 200) {
                continue;
            }
            $hour = intdiv($entry['t'], self::HOUR) * self::HOUR;
            $key = $hour . '/' . ($entry['route'] ?? '');
            $bucket = $buckets[$key] ?? ['hour' => $hour, 'route' => $entry['route'], 'requests' => 0, 's2' => 0, 's3' => 0, 's4' => 0, 's5' => 0, 'errors' => [], 'msTotal' => 0, 'msMax' => 0];
            ++$bucket['requests'];
            $class = intdiv($entry['status'], 100);
            $field = $class === 2 ? 's2' : ($class === 3 ? 's3' : ($class === 4 ? 's4' : 's5'));
            ++$bucket[$field];
            if ($entry['error'] !== null) {
                $bucket['errors'][$entry['error']] = ($bucket['errors'][$entry['error']] ?? 0) + 1;
            }
            $bucket['msTotal'] += $entry['ms'];
            $bucket['msMax'] = max($bucket['msMax'], $entry['ms']);
            $buckets[$key] = $bucket;
        }
        $hours = array_values($buckets);
        usort($hours, static function (array $a, array $b): int {
            if ($a['hour'] !== $b['hour']) {
                return $a['hour'] <=> $b['hour'];
            }
            if ($a['route'] === $b['route']) {
                return 0;
            }

            return $a['route'] === null ? 1 : ($b['route'] === null ? -1 : strcmp($a['route'], $b['route']));
        });
        $hours = \array_slice($hours, -self::MAX_BUCKETS);
        $out = [];
        foreach ($hours as $bucket) {
            $out[] = [
                'hour' => $bucket['hour'],
                'route' => $bucket['route'],
                'requests' => $bucket['requests'],
                's2' => $bucket['s2'],
                's3' => $bucket['s3'],
                's4' => $bucket['s4'],
                's5' => $bucket['s5'],
                'errors' => self::topErrors($bucket['errors']),
                'msTotal' => $bucket['msTotal'],
                'msMax' => $bucket['msMax'],
            ];
        }

        return [['v' => 1, 'gateId' => $gateId, 'hours' => $out], $current];
    }

    /**
     * The report as JSON, `errors` always an object.
     *
     * @param array{v: int, gateId: string, hours: list<array<string, mixed>>} $report
     */
    public static function encode(array $report): string
    {
        $hours = [];
        foreach ($report['hours'] as $bucket) {
            $errors = $bucket['errors'] ?? [];
            $hours[] = array_merge($bucket, ['errors' => \is_array($errors) && $errors !== [] ? $errors : new \stdClass()]);
        }

        return json_encode(['v' => $report['v'], 'gateId' => $report['gateId'], 'hours' => $hours], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
    }

    /**
     * The log lines as entries; a line that is not one (damaged, cut off) is left out, as in
     * libs/core parseRequestLog.
     *
     * @param list<string> $lines
     *
     * @return list<array{t: int, route: ?string, status: int, error: ?string, ms: int}>
     */
    public static function entries(array $lines): array
    {
        $entries = [];
        foreach ($lines as $line) {
            try {
                $value = StrictJson::decode($line);
            } catch (Rejection) {
                continue;
            }
            if (!$value instanceof JsonObject || !$value->hasExactKeys('t', 'route', 'method', 'status', 'error', 'ms', 'client')) {
                continue;
            }
            $t = $value->get('t');
            $route = $value->get('route');
            $status = $value->get('status');
            $error = $value->get('error');
            $ms = $value->get('ms');
            if (
                !\is_int($t) || $t < 0
                || !($route === null || (\is_string($route) && preg_match('/^[a-z][a-z0-9-]{0,62}$/D', $route) === 1))
                || !\is_int($status) || $status < 100 || $status > 599
                || !($error === null || (\is_string($error) && preg_match('/^[a-z][a-z_]{0,62}$/D', $error) === 1))
                || !\is_int($ms) || $ms < 0
            ) {
                continue;
            }
            $entries[] = ['t' => $t, 'route' => $route, 'status' => $status, 'error' => $error, 'ms' => $ms];
        }

        return $entries;
    }

    /**
     * @param array<string, int> $errors
     *
     * @return array<string, int>
     */
    private static function topErrors(array $errors): array
    {
        $codes = array_keys($errors);
        usort($codes, static fn(string $a, string $b): int => $errors[$a] !== $errors[$b] ? $errors[$b] <=> $errors[$a] : strcmp($a, $b));
        $kept = [];
        foreach (\array_slice($codes, 0, self::MAX_ERROR_CODES) as $code) {
            $kept[$code] = $errors[$code];
        }
        ksort($kept, SORT_STRING);

        return $kept;
    }
}
