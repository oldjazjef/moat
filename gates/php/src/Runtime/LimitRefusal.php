<?php

declare(strict_types=1);

namespace Moat\Gate\Runtime;

/**
 * A request the limits refuse: `retryAfter` seconds until every full window has ended, and
 * whether a full quota is among them (FR-31: `quota_exceeded` instead of `rate_limited`).
 */
final readonly class LimitRefusal
{
    public function __construct(
        public int $retryAfter,
        public bool $quota,
    ) {}
}
