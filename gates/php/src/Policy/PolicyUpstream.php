<?php

declare(strict_types=1);

namespace Moat\Gate\Policy;

use Moat\Gate\Config\Budget;
use Moat\Gate\Config\Method;

final readonly class PolicyUpstream
{
    /**
     * @param list<string> $pathPrefixes
     * @param list<Method> $methods
     * @param list<string> $secrets names of the secrets that may be sent to this host (SEC-35)
     */
    public function __construct(
        public array $pathPrefixes,
        public array $methods,
        public array $secrets,
        /** FR-31, SEC-14: tokens per period for everything sent to this host (no cost); null = none. */
        public ?Budget $budget = null,
        /** FR-13, SEC-14: every route to this host lists its body fields or takes no body (`maxBodyBytes` 0). */
        public bool $requireBody = false,
    ) {}
}
