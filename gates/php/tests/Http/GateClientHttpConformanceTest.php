<?php

declare(strict_types=1);

namespace Moat\Gate\Tests\Http;

/** Client protection per route: API key, JWT, Turnstile, honeypot (conformance/http/gate-client.json, FR-16). */
final class GateClientHttpConformanceTest extends HttpConformanceCase
{
    protected static function casesFile(): string
    {
        return 'http/gate-client.json';
    }
}
