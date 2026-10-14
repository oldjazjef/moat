<?php

declare(strict_types=1);

namespace Moat\Gate\Config;

/** FR-20: where an OAuth2 upstream's access token comes from, and the scope asked for. */
final readonly class TokenEndpoint
{
    public function __construct(
        /** `https://host[:port]` */
        public string $origin,
        public string $path,
        public ?string $scope,
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

    public function url(): string
    {
        return $this->origin . $this->path;
    }
}
