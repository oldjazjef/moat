<?php

declare(strict_types=1);

namespace Moat\Gate\Tests\Http;

/** The gate reports its traffic to the policy's place (conformance/http/gate-report.json, FR-50, T-110). */
final class ReportHttpConformanceTest extends HttpConformanceCase
{
    protected static function casesFile(): string
    {
        return 'http/gate-report.json';
    }
}
