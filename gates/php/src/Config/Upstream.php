<?php

declare(strict_types=1);

namespace Moat\Gate\Config;

final readonly class Upstream
{
    public function __construct(
        public string $origin,
        public ?Auth $auth,
        public int $timeoutMs,
    ) {}

    /** `host[:port]` — the key of the local policy's upstream allowlist. */
    public function hostKey(): string
    {
        return substr($this->origin, \strlen('https://'));
    }

    public function host(): string
    {
        return explode(':', $this->hostKey(), 2)[0];
    }

    public function port(): int
    {
        $parts = explode(':', $this->hostKey(), 2);

        return isset($parts[1]) ? (int) $parts[1] : 443;
    }
}
