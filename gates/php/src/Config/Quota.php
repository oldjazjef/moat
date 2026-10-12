<?php

declare(strict_types=1);

namespace Moat\Gate\Config;

/**
 * At most `requests` per calendar day or month in UTC (FR-31, T-07): for a whole route, or in the
 * local policy for the whole gate.
 */
final readonly class Quota
{
    public function __construct(
        public int $requests,
        public QuotaPeriod $period,
    ) {}
}
