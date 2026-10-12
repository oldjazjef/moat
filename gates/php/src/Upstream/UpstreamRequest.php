<?php

declare(strict_types=1);

namespace Moat\Gate\Upstream;

/** One call to an allowed upstream, built only from the config and the checked request. */
final readonly class UpstreamRequest
{
    /**
     * @param non-empty-string      $method
     * @param array<string, string> $headers  exactly the headers to send
     * @param list<string>          $accept   allowed response media types
     */
    public function __construct(
        public string $method,
        public string $host,
        public int $port,
        public string $pathAndQuery,
        public array $headers,
        public string $body,
        public int $timeoutMs,
        public int $maxResponseBytes,
        public array $accept,
    ) {}
}
