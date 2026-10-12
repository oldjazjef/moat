<?php

declare(strict_types=1);

namespace Moat\Gate\Http;

use Moat\Gate\Config\Route;
use Moat\Gate\Rejection;
use Moat\Gate\RejectionCode;

/**
 * FR-15: origin binding and CORS, exactly as libs/core/src/http/cors.ts
 * (conformance/vectors/http/cors.json). It stops browsers only — a script sends any Origin or
 * none (T-01, SEC-58). Credentials are never allowed: the gate uses no cookies.
 */
final class Cors
{
    public const MAX_AGE = 600;
    private const ALLOWED_REQUEST_HEADERS = ['content-type'];

    /**
     * The Access-Control-Allow-Origin value for a request to `$route`, or null for none. A route
     * that lists origins refuses a request carrying another one (`origin_forbidden`).
     */
    public static function check(Route $route, ?string $origin): ?string
    {
        if ($route->origins === [] || $origin === null) {
            return null;
        }
        if (!\in_array($origin, $route->origins, true)) {
            throw new Rejection(RejectionCode::OriginForbidden);
        }

        return $origin;
    }

    /**
     * The headers of a preflight answer on a path with these routes; `preflight_rejected` unless
     * a route lists the origin and has the method, and only Content-Type is requested.
     *
     * @param list<Route> $routes
     *
     * @return array<string, string>
     */
    public static function preflight(array $routes, string $origin, string $requestMethod, ?string $requestHeaders): array
    {
        $methods = [];
        foreach ($routes as $route) {
            if (\in_array($origin, $route->origins, true)) {
                $methods[] = $route->method->value;
            }
        }
        if (!\in_array($requestMethod, $methods, true)) {
            throw new Rejection(RejectionCode::PreflightRejected);
        }
        foreach (self::headerList($requestHeaders) as $name) {
            if (!\in_array($name, self::ALLOWED_REQUEST_HEADERS, true)) {
                throw new Rejection(RejectionCode::PreflightRejected);
            }
        }
        $methods = array_values(array_unique($methods));
        sort($methods);

        return [
            'Access-Control-Allow-Origin' => $origin,
            'Access-Control-Allow-Methods' => implode(', ', $methods),
            'Access-Control-Allow-Headers' => 'Content-Type',
            'Access-Control-Max-Age' => (string) self::MAX_AGE,
        ];
    }

    /** @return list<string> lower-cased header names; empty items skipped */
    private static function headerList(?string $value): array
    {
        if ($value === null) {
            return [];
        }
        $names = [];
        foreach (explode(',', $value) as $item) {
            $name = trim($item, " \t");
            if ($name === '') {
                continue;
            }
            if (preg_match("/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/D", $name) !== 1) {
                throw new Rejection(RejectionCode::PreflightRejected);
            }
            $names[] = strtolower($name);
        }

        return $names;
    }
}
