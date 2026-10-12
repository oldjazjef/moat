<?php

declare(strict_types=1);

namespace Moat\Gate\Config;

final readonly class Route
{
    /**
     * @param list<string> $contentTypes
     * @param list<string> $responseContentTypes
     * @param list<string> $origins browser origins allowed cross-origin (FR-15); empty = none
     */
    public function __construct(
        public string $name,
        public Method $method,
        public string $path,
        public string $upstream,
        public string $upstreamPath,
        public int $maxBodyBytes,
        public array $contentTypes,
        public array $responseContentTypes,
        public bool $enabled,
        public array $origins,
        public ?RouteLimit $rateLimit,
    ) {}
}
