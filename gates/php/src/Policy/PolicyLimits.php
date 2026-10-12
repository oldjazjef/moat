<?php

declare(strict_types=1);

namespace Moat\Gate\Policy;

use Moat\Gate\Config\Limit;
use Moat\Gate\Config\Quota;

/**
 * Rate limits the gate enforces on every route whatever the bundle says (SEC-14, SEC-45, T-21):
 * per client address and in total, with a bounded counter store (SEC-27), and optionally a quota
 * for all requests per calendar day or month (FR-31, T-07).
 */
final readonly class PolicyLimits
{
    public const MIN_CLIENTS = 100;
    public const MAX_CLIENTS = 20_000;

    public function __construct(
        public Limit $perIp,
        public Limit $total,
        public int $maxClients,
        public ?Quota $quota = null,
    ) {}
}
