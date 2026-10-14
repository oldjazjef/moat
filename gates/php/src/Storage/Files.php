<?php

declare(strict_types=1);

namespace Moat\Gate\Storage;

/**
 * The only place that reads and writes files, and the only allowed use of file_get_contents and
 * fopen in src/ (phpstan.neon): local paths and php://input, never a URL — all HTTP goes through
 * the one cURL client.
 */
final class Files
{
    public const LOCK_WAIT_SECONDS = 0.25;

    /** The file's bytes, at most `$maxBytes` + 1 of them (so a caller can tell "too large"); null if missing. */
    public static function read(string $path, int $maxBytes): ?string
    {
        if (!is_file($path) || str_contains($path, '://')) {
            return null;
        }
        $bytes = file_get_contents($path, false, null, 0, max(0, $maxBytes) + 1);

        return $bytes === false ? null : $bytes;
    }

    /** The request body, at most `$maxBytes` + 1 bytes. */
    public static function readInput(int $maxBytes): string
    {
        $bytes = file_get_contents('php://input', false, null, 0, max(0, $maxBytes) + 1);

        return $bytes === false ? '' : $bytes;
    }

    /**
     * Atomic write: a temp file in the same folder, then rename (CLAUDE.md, PHP standards). The
     * temp file ends in `.php` too, so a leftover copy of a guarded data file stays guarded.
     */
    public static function writeAtomic(string $path, string $bytes, int $mode = 0o600): void
    {
        $temp = \dirname($path) . '/.tmp-' . bin2hex(random_bytes(8)) . '.php';
        $handle = fopen($temp, 'xb');
        if ($handle === false) {
            throw new \RuntimeException('cannot create a temp file');
        }
        try {
            chmod($temp, $mode);
            if (fwrite($handle, $bytes) !== \strlen($bytes) || !fflush($handle)) {
                throw new \RuntimeException('cannot write a temp file');
            }
        } catch (\Throwable $error) {
            fclose($handle);
            unlink($temp);

            throw $error;
        }
        fclose($handle);
        if (!rename($temp, $path)) {
            unlink($temp);

            throw new \RuntimeException('cannot replace a data file');
        }
    }

    /** Appends to an existing file; only under the caller's lock (the request log). */
    public static function append(string $path, string $bytes): void
    {
        if (str_contains($path, '://') || !is_file($path)) {
            throw new \RuntimeException('not a local file');
        }
        $handle = fopen($path, 'ab');
        if ($handle === false) {
            throw new \RuntimeException('cannot open a data file');
        }
        try {
            if (fwrite($handle, $bytes) !== \strlen($bytes) || !fflush($handle)) {
                throw new \RuntimeException('cannot append to a data file');
            }
        } finally {
            fclose($handle);
        }
    }

    /**
     * Runs `$critical` while holding an exclusive lock on `$path` (created with `$initial` when
     * missing, so a guarded lock file stays guarded). Waits at most LOCK_WAIT_SECONDS, then throws.
     *
     * @template T
     *
     * @param \Closure(): T $critical
     *
     * @return T
     */
    public static function withLock(string $path, string $initial, \Closure $critical): mixed
    {
        if (str_contains($path, '://')) {
            throw new \RuntimeException('not a local path');
        }
        $handle = fopen($path, 'cb');
        if ($handle === false) {
            throw new \RuntimeException('cannot open a lock file');
        }
        try {
            // Never queue every PHP worker behind one slow request: give up after a short wait.
            $deadline = microtime(true) + self::LOCK_WAIT_SECONDS;
            while (!flock($handle, LOCK_EX | LOCK_NB)) {
                if (microtime(true) > $deadline) {
                    throw new \RuntimeException('lock busy');
                }
                usleep(2000);
            }
            $stat = fstat($handle);
            if ($stat !== false && $stat['size'] === 0) {
                try {
                    chmod($path, 0o600);
                } catch (\ErrorException) {
                    // Some hosts forbid chmod; the hardening check reports the open permissions.
                }
                fwrite($handle, $initial);
                fflush($handle);
            }

            return $critical();
        } finally {
            flock($handle, LOCK_UN);
            fclose($handle);
        }
    }
}
