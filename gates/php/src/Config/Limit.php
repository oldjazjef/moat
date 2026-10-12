<?php

declare(strict_types=1);

namespace Moat\Gate\Config;

/** At most `requests` in a window of `windowSeconds` that opens with the first request (FR-30). */
final readonly class Limit
{
    public const MAX_REQUESTS = 1_000_000;
    public const MAX_WINDOW_SECONDS = 86_400;

    public function __construct(
        public int $requests,
        public int $windowSeconds,
    ) {}
}
