<?php

declare(strict_types=1);

namespace Moat\Gate\Policy;

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
    ) {}
}
