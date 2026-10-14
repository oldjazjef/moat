<?php

declare(strict_types=1);

namespace Moat\Gate\Tests\Http;

/** The setup mode (conformance/http/gate-setup.json, SEC-28). */
final class GateSetupHttpConformanceTest extends HttpConformanceCase
{
    protected static function casesFile(): string
    {
        return 'http/gate-setup.json';
    }
}
