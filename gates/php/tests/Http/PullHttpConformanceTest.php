<?php

declare(strict_types=1);

namespace Moat\Gate\Tests\Http;

/** The lazy pull fetches new bundles from the policy's place (conformance/http/gate-pull.json, DT-11). */
final class PullHttpConformanceTest extends HttpConformanceCase
{
    protected static function casesFile(): string
    {
        return 'http/gate-pull.json';
    }
}
