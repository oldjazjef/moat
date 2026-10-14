<?php

declare(strict_types=1);

namespace Moat\Gate\Tests\Http;

/** The request log (conformance/http/gate-log.json, FR-50, DT-12). */
final class GateLogHttpConformanceTest extends HttpConformanceCase
{
    protected static function casesFile(): string
    {
        return 'http/gate-log.json';
    }
}
