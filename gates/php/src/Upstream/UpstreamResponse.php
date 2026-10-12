<?php

declare(strict_types=1);

namespace Moat\Gate\Upstream;

final readonly class UpstreamResponse
{
    /** @param ?string $mediaType the checked media type; null only for an empty body */
    public function __construct(
        public int $status,
        public ?string $mediaType,
        public string $body,
    ) {}
}
