<?php

declare(strict_types=1);

namespace Moat\Gate\Policy;

use Moat\Gate\Config\Method;

final readonly class PolicyUpstream
{
    /**
     * @param list<string> $pathPrefixes
     * @param list<Method> $methods
     */
    public function __construct(
        public array $pathPrefixes,
        public array $methods,
    ) {}
}
