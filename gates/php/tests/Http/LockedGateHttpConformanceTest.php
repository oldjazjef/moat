<?php

declare(strict_types=1);

namespace Moat\Gate\Tests\Http;

/** A locked gate refuses everything (conformance/http/gate-locked.json). */
final class LockedGateHttpConformanceTest extends HttpConformanceCase
{
    protected static function casesFile(): string
    {
        return 'http/gate-locked.json';
    }
}
