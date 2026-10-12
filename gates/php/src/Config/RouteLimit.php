<?php

declare(strict_types=1);

namespace Moat\Gate\Config;

final readonly class RouteLimit
{
    public function __construct(
        public Limit $limit,
        public LimitScope $per,
    ) {}
}
