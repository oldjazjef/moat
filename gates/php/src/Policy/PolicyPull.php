<?php

declare(strict_types=1);

namespace Moat\Gate\Policy;

/**
 * Where the gate fetches new bundles by itself (DT-11, lazy pull): set only in the local policy,
 * so no bundle can name or move the place (SEC-10). The place needs no trust: every bundle from
 * it goes through the same checks as `accept`.
 */
final readonly class PolicyPull
{
    public const MIN_INTERVAL = 60;
    public const MAX_INTERVAL = 86_400;
    public const MAX_URL = 2048;

    public function __construct(
        public string $host,
        public int $port,
        /** The path to the file, starting with "/". */
        public string $path,
        public int $intervalSeconds,
    ) {}

    public function url(): string
    {
        return 'https://' . $this->host . ($this->port === 443 ? '' : ':' . $this->port) . $this->path;
    }
}
