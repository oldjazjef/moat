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
    /** The file's bytes, at most `$maxBytes` + 1 of them (so a caller can tell "too large"); null if missing. */
    public static function read(string $path, int $maxBytes): ?string
    {
        if (!is_file($path) || str_contains($path, '://')) {
            return null;
        }
        $bytes = file_get_contents($path, false, null, 0, $maxBytes + 1);

        return $bytes === false ? null : $bytes;
    }

    /** The request body, at most `$maxBytes` + 1 bytes. */
    public static function readInput(int $maxBytes): string
    {
        $bytes = file_get_contents('php://input', false, null, 0, $maxBytes + 1);

        return $bytes === false ? '' : $bytes;
    }

    /** Atomic write: a temp file in the same folder, then rename (CLAUDE.md, PHP standards). */
    public static function writeAtomic(string $path, string $bytes, int $mode = 0o600): void
    {
        $temp = \dirname($path) . '/.tmp-' . bin2hex(random_bytes(8));
        $handle = fopen($temp, 'xb');
        if ($handle === false) {
            throw new \RuntimeException('cannot create a temp file');
        }
        try {
            chmod($temp, $mode);
            if (fwrite($handle, $bytes) !== \strlen($bytes) || !fflush($handle)) {
                throw new \RuntimeException('cannot write a temp file');
            }
        } finally {
            fclose($handle);
        }
        if (!rename($temp, $path)) {
            unlink($temp);

            throw new \RuntimeException('cannot replace a data file');
        }
    }
}
