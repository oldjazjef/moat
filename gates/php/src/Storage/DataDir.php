<?php

declare(strict_types=1);

namespace Moat\Gate\Storage;

/**
 * The gate's data folder next to the gate file (CLAUDE.md, PHP standards, "Data files on H1"):
 * a random name, `.htaccess`, `web.config` and an empty `index.php`, and data files that end in
 * `.php` and stop PHP before their content — fetched over HTTP they answer 404 and show nothing.
 */
final readonly class DataDir
{
    public const PREFIX = 'moat-data-';
    public const MARKER = "<?php http_response_code(404); exit; __halt_compiler();";
    public const MAX_FILE_BYTES = 2 * 1024 * 1024;

    private function __construct(public string $path) {}

    /** The one data folder next to the gate, or null when there is none (or more than one). */
    public static function locate(string $gateDir): ?self
    {
        $found = glob($gateDir . '/' . self::PREFIX . '*', GLOB_ONLYDIR | GLOB_NOSORT);
        $found = array_values(array_filter(
            $found === false ? [] : $found,
            static fn(string $dir): bool => preg_match('/^' . self::PREFIX . '[0-9a-f]{32}$/D', basename($dir)) === 1,
        ));

        return \count($found) === 1 ? new self($found[0]) : null;
    }

    public static function create(string $gateDir): self
    {
        if (self::locate($gateDir) !== null) {
            throw new \RuntimeException('this gate is already installed');
        }
        $path = $gateDir . '/' . self::PREFIX . bin2hex(random_bytes(16));
        if (!mkdir($path, 0o700)) {
            throw new \RuntimeException('cannot create the data folder');
        }
        Files::writeAtomic($path . '/.htaccess', "Require all denied\n<IfModule !mod_authz_core.c>\nDeny from all\n</IfModule>\n", 0o644);
        Files::writeAtomic(
            $path . '/web.config',
            "<?xml version=\"1.0\"?>\n<configuration><system.webServer><authorization><deny users=\"*\" /></authorization></system.webServer></configuration>\n",
            0o644,
        );
        Files::writeAtomic($path . '/index.php', self::MARKER . "\n", 0o644);

        return new self($path);
    }

    /** The content after the marker; null when the file is missing. A damaged file throws. */
    public function read(string $name): ?string
    {
        $bytes = Files::read($this->file($name), self::MAX_FILE_BYTES);
        if ($bytes === null) {
            return null;
        }
        if (\strlen($bytes) > self::MAX_FILE_BYTES || !str_starts_with($bytes, self::MARKER . "\n")) {
            throw new \RuntimeException('a data file is damaged');
        }

        return substr($bytes, \strlen(self::MARKER) + 1);
    }

    public function write(string $name, string $content): void
    {
        Files::writeAtomic($this->file($name), self::MARKER . "\n" . $content);
    }

    /**
     * Runs `$critical` under the data folder's one exclusive lock (`lock.php`, guarded like the
     * data files) — for read-modify-write of a data file by concurrent requests.
     *
     * @template T
     *
     * @param \Closure(): T $critical
     *
     * @return T
     */
    public function locked(\Closure $critical): mixed
    {
        return Files::withLock($this->file('lock'), self::MARKER . "\n", $critical);
    }

    private function file(string $name): string
    {
        if (preg_match('/^[a-z]{1,16}$/D', $name) !== 1) {
            throw new \InvalidArgumentException('bad data file name');
        }

        return $this->path . '/' . $name . '.php';
    }
}
