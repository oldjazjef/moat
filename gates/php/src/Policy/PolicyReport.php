<?php

declare(strict_types=1);

namespace Moat\Gate\Policy;

/**
 * Where the gate sends its traffic report (FR-50, T-110): set only in the local policy, so no
 * bundle can name or move the place (SEC-10). The address is the gate's credential towards that
 * place; the gate sends sums only and takes nothing back from it.
 */
final readonly class PolicyReport
{
    public const MIN_INTERVAL = 300;
    public const MAX_INTERVAL = 86_400;

    public function __construct(
        public string $host,
        public int $port,
        /** The path, starting with "/". */
        public string $path,
        public int $intervalSeconds,
    ) {}

    /** The address without its last path segment (the token), for `status` and errors. */
    public function shownUrl(): string
    {
        $cut = strrpos($this->path, '/');

        return 'https://' . $this->host . ($this->port === 443 ? '' : ':' . $this->port) . substr($this->path, 0, $cut === false ? 0 : $cut) . '/…';
    }
}
