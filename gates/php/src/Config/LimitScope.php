<?php

declare(strict_types=1);

namespace Moat\Gate\Config;

/** What a route's rate limit counts: each client IP, or every request to the route together. */
enum LimitScope: string
{
    case Ip = 'ip';
    case Route = 'route';
}
