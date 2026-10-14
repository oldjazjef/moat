<?php

declare(strict_types=1);

namespace Moat\Gate\Tests\Http;

/** Upstream authentication with Basic and OAuth2 client credentials (conformance/http/gate-auth.json, FR-20). */
final class GateAuthHttpConformanceTest extends HttpConformanceCase
{
    protected static function casesFile(): string
    {
        return 'http/gate-auth.json';
    }
}
