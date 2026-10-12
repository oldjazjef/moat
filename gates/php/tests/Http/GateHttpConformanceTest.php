<?php

declare(strict_types=1);

namespace Moat\Gate\Tests\Http;

/** The gate in service: routing, gating, forwarding (conformance/http/gate.json). */
final class GateHttpConformanceTest extends HttpConformanceCase
{
    protected static function casesFile(): string
    {
        return 'http/gate.json';
    }
}
