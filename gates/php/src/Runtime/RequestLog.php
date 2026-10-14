<?php

declare(strict_types=1);

namespace Moat\Gate\Runtime;

use Moat\Gate\Encoding\Base64Url;
use Moat\Gate\Storage\DataDir;

/**
 * The request log (FR-50, DT-12, conformance/http/gate-log.json, libs/core gate/request-log.ts):
 * one JSON line per request in the data file `log` — time, route name, method, status, the gate's
 * error code, duration and a client hash. Never a path, query, header, body or address (SEC-34).
 * Past the policy's `logMaxBytes` the file becomes `logold` and a new one starts. Writing the log
 * never changes an answer: when it fails (a busy lock, a full disk), the line is lost.
 */
final class RequestLog
{
    public const FILE = 'log';
    public const OLD = 'logold';
    public const KEY = 'logkey';
    public const LOCK = 'loglock';
    public const DEFAULT_MAX_BYTES = 262_144;
    public const MAX_BYTES = 1_048_576;

    public static function record(DataDir $data, int $maxBytes, int $now, ?string $route, string $method, int $status, ?string $error, int $ms, string $remoteAddr): void
    {
        if ($maxBytes <= 0) {
            return;
        }
        try {
            $data->locked(static function () use ($data, $maxBytes, $now, $route, $method, $status, $error, $ms, $remoteAddr): void {
                $line = json_encode([
                    't' => $now,
                    'route' => $route,
                    'method' => preg_match('/^[A-Z]{1,10}$/D', $method) === 1 ? $method : 'OTHER',
                    'status' => $status,
                    'error' => $error,
                    'ms' => max(0, $ms),
                    'client' => self::client($data, $now, $remoteAddr),
                ], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES) . "\n";
                $size = $data->contentSize(self::FILE);
                if ($size !== null && $size + \strlen($line) > $maxBytes) {
                    $data->rename(self::FILE, self::OLD);
                    $size = null;
                }
                if ($size === null) {
                    $data->write(self::FILE, '');
                }
                $data->append(self::FILE, $line);
            }, self::LOCK);
        } catch (\Exception) {
            // Observability only: a request is never refused or changed because its line is lost.
        }
    }

    /**
     * The log as `php moat-gate.php log` prints it: `logold`, then `log`, the last `$limit` lines.
     *
     * @return list<string>
     */
    public static function lines(DataDir $data, int $limit): array
    {
        $lines = [];
        foreach ([self::OLD, self::FILE] as $name) {
            $content = $data->read($name) ?? '';
            foreach (explode("\n", $content) as $line) {
                if ($line !== '') {
                    $lines[] = $line;
                }
            }
        }

        return \array_slice($lines, -max(1, $limit));
    }

    /**
     * 16 hex digits of a keyed BLAKE2b over the client (ClientKey: IPv4, or the IPv6 /64) and the
     * UTC day: the same client is one id for one day, and the address cannot be read back. The key
     * is random, kept in the data file `logkey`, and never leaves the server.
     */
    private static function client(DataDir $data, int $now, string $remoteAddr): string
    {
        try {
            $key = Base64Url::decode(trim($data->read(self::KEY) ?? ''));
        } catch (\RuntimeException) {
            // Missing or damaged: a new key (yesterday's ids no longer match, nothing else).
            $key = '';
        }
        if (\strlen($key) !== SODIUM_CRYPTO_GENERICHASH_KEYBYTES) {
            $key = random_bytes(SODIUM_CRYPTO_GENERICHASH_KEYBYTES);
            $data->write(self::KEY, Base64Url::encode($key) . "\n");
        }
        $client = ClientKey::of($remoteAddr) ?? 'unknown';
        $id = bin2hex(substr(sodium_crypto_generichash($client . "\n" . gmdate('Y-m-d', $now), $key, 16), 0, 8));
        sodium_memzero($key);

        return $id;
    }
}
