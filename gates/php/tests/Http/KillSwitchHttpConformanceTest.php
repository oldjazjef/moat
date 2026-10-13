<?php

declare(strict_types=1);

namespace Moat\Gate\Tests\Http;

/** The local kill switch switches a gate or a route off at once (conformance/http/gate-kill-switch.json). */
final class KillSwitchHttpConformanceTest extends HttpConformanceCase
{
    protected static function casesFile(): string
    {
        return 'http/gate-kill-switch.json';
    }
}
