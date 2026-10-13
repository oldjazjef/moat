<?php

declare(strict_types=1);

namespace Moat\Gate\Config;

use Moat\Gate\Http\ContentType;
use Moat\Gate\Http\PathNormaliser;
use Moat\Gate\Json\JsonObject;
use Moat\Gate\Rejection;
use Moat\Gate\RejectionCode;

/**
 * Step 9 of docs/CRYPTO.md §4.3: the compiled config of an authentic bundle, exactly as
 * libs/core/src/config/compiled.ts checks it (conformance/vectors/config/config.json). Strict
 * keys, closed value sets, no dangling reference, no duplicate method + path. Anything else →
 * `config_invalid` (SEC-20, SEC-46).
 */
final class ConfigValidator
{
    public const NAME = '/^[a-z][a-z0-9-]{0,62}$/D';
    public const MAX_BODY_BYTES = 10 * 1024 * 1024;
    public const MAX_TIMEOUT_MS = 60_000;
    public const MAX_ORIGINS = 16;
    public const JSON = 'application/json';
    /** SEC-27: at most this many routes have a budget (MAX_ROUTE_BUDGETS in libs/core). */
    public const MAX_ROUTE_BUDGETS = 256;
    private const HEADER_NAME = '/^[A-Za-z0-9-]{1,64}$/D';
    private const QUERY_PARAM = '/^[A-Za-z0-9_.-]{1,64}$/D';
    /** Headers the gate sets itself; an auth header may not replace them. */
    private const RESERVED_HEADERS = [
        'host', 'content-type', 'content-length', 'transfer-encoding', 'connection', 'te', 'upgrade',
        'user-agent', 'accept', 'accept-encoding', 'cookie', 'proxy-authorization',
    ];

    /** @param list<string> $secretNames the names of the bundle's sealed secrets */
    public static function validate(mixed $config, array $secretNames): CompiledConfig
    {
        if (!$config instanceof JsonObject || $config->get('version') !== 1) {
            self::fail();
        }
        // `enabled` is optional: compiled only when the gate or its environment is locked.
        $hasEnabled = $config->has('enabled');
        if (!($hasEnabled ? $config->hasExactKeys('version', 'enabled', 'upstreams', 'routes') : $config->hasExactKeys('version', 'upstreams', 'routes'))) {
            self::fail();
        }
        $enabled = $hasEnabled ? $config->get('enabled') : true;
        if (!\is_bool($enabled)) {
            self::fail();
        }
        $upstreams = [];
        foreach (self::record($config->get('upstreams')) as $name => $value) {
            $upstreams[$name] = self::upstream($value, $secretNames);
        }
        $routes = [];
        $seen = [];
        foreach (self::record($config->get('routes')) as $name => $value) {
            $route = self::route($name, $value);
            if (!isset($upstreams[$route->upstream])) {
                self::fail();
            }
            $key = $route->method->value . ' ' . $route->path;
            if (isset($seen[$key])) {
                self::fail();
            }
            $seen[$key] = true;
            $routes[$name] = $route;
        }
        // SEC-27: the budget store holds every route budget next to the policy's host budgets.
        if (\count(array_filter($routes, static fn(Route $route): bool => $route->budget !== null)) > self::MAX_ROUTE_BUDGETS) {
            self::fail();
        }

        return new CompiledConfig($upstreams, $routes, $enabled);
    }

    /** `https://host[:port]`, as isOrigin() in libs/core. */
    public static function isOrigin(string $value): bool
    {
        if (preg_match('~^https://([^:/?#@]+)(?::([1-9][0-9]{0,4}))?$~D', $value, $match) !== 1) {
            return false;
        }
        $host = $match[1];
        $port = $match[2] ?? null;
        if ($port !== null && ((int) $port > 65535 || $port === '443')) {
            return false;
        }
        if (\strlen($host) > 253) {
            return false;
        }
        $labels = explode('.', $host);
        foreach ($labels as $label) {
            if (preg_match('/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/D', $label) !== 1) {
                return false;
            }
        }

        return preg_match('/^[0-9]+$/D', $labels[\count($labels) - 1]) !== 1;
    }

    /** @return array<string, mixed> a JSON object whose keys are all names */
    private static function record(mixed $value): array
    {
        if (!$value instanceof JsonObject) {
            self::fail();
        }
        foreach ($value->keys() as $key) {
            if (preg_match(self::NAME, $key) !== 1) {
                self::fail();
            }
        }

        return $value->members();
    }

    /** @param list<string> $secretNames */
    private static function upstream(mixed $value, array $secretNames): Upstream
    {
        if (!$value instanceof JsonObject || !$value->hasExactKeys('origin', 'auth', 'timeoutMs')) {
            self::fail();
        }
        $origin = $value->get('origin');
        $timeoutMs = $value->get('timeoutMs');
        if (!\is_string($origin) || !self::isOrigin($origin) || !\is_int($timeoutMs) || !self::intIn($timeoutMs, 1, self::MAX_TIMEOUT_MS)) {
            self::fail();
        }
        $auth = $value->get('auth') === null ? null : self::auth($value->get('auth'));
        if ($auth !== null && !\in_array($auth->secret, $secretNames, true)) {
            self::fail();
        }

        return new Upstream($origin, $auth, $timeoutMs);
    }

    private static function auth(mixed $value): Auth
    {
        if (!$value instanceof JsonObject) {
            self::fail();
        }
        $type = \is_string($value->get('type')) ? AuthType::tryFrom($value->get('type')) : null;
        if ($type === null) {
            self::fail();
        }
        $secret = $value->get('secret');
        $name = '';
        $valid = match ($type) {
            AuthType::Bearer => $value->hasExactKeys('type', 'secret'),
            AuthType::Header => $value->hasExactKeys('type', 'name', 'secret')
                && \is_string($name = $value->get('name'))
                && preg_match(self::HEADER_NAME, $name) === 1
                && !\in_array(strtolower($name), self::RESERVED_HEADERS, true),
            AuthType::Query => $value->hasExactKeys('type', 'param', 'secret')
                && \is_string($name = $value->get('param'))
                && preg_match(self::QUERY_PARAM, $name) === 1,
        };
        if (!$valid || !\is_string($secret) || preg_match(self::NAME, $secret) !== 1 || !\is_string($name)) {
            self::fail();
        }

        return new Auth($type, $name, $secret);
    }

    private static function route(string $name, mixed $value): Route
    {
        if (!$value instanceof JsonObject || !$value->hasExactKeys(
            'method',
            'path',
            'upstream',
            'upstreamPath',
            'maxBodyBytes',
            'contentTypes',
            'responseContentTypes',
            'enabled',
            'origins',
            'rateLimit',
            ...($value->has('quota') ? ['quota'] : []),
            ...($value->has('budget') ? ['budget'] : []),
        )) {
            self::fail();
        }
        $method = \is_string($value->get('method')) ? Method::tryFrom($value->get('method')) : null;
        $path = $value->get('path');
        $upstream = $value->get('upstream');
        $upstreamPath = $value->get('upstreamPath');
        $maxBodyBytes = $value->get('maxBodyBytes');
        $enabled = $value->get('enabled');
        if (
            $method === null
            || !\is_string($path) || !PathNormaliser::isRoutePath($path)
            || !\is_string($upstream) || preg_match(self::NAME, $upstream) !== 1
            || !\is_string($upstreamPath) || !PathNormaliser::isRoutePath($upstreamPath)
            || !\is_int($maxBodyBytes) || !self::intIn($maxBodyBytes, 0, self::MAX_BODY_BYTES)
            || !\is_bool($enabled)
        ) {
            self::fail();
        }

        $responseTypes = self::mediaTypes($value->get('responseContentTypes'));
        $budget = $value->has('budget') ? self::budget($value->get('budget'), RejectionCode::ConfigInvalid, true) : null;
        // A budget is counted from the usage in a JSON answer; any other answer cannot be counted.
        if ($budget !== null && array_diff($responseTypes, [self::JSON]) !== []) {
            self::fail();
        }

        return new Route(
            $name,
            $method,
            $path,
            $upstream,
            $upstreamPath,
            $maxBodyBytes,
            self::mediaTypes($value->get('contentTypes')),
            $responseTypes,
            $enabled,
            self::origins($value->get('origins')),
            $value->get('rateLimit') === null ? null : self::routeLimit($value->get('rateLimit')),
            $value->has('quota') ? self::quota($value->get('quota'), RejectionCode::ConfigInvalid) : null,
            $budget,
        );
    }

    /**
     * A budget (FR-31) as budgetSchema in libs/core: `usage`, `period`, `reserve`, and `tokens`
     * and/or a `cost` (`limit`, `inputPerMillion`, `outputPerMillion` as decimal text) — or, in the
     * local policy (`$withCost` false), exactly `usage`, `period`, `reserve` and `tokens`. Else a
     * Rejection with `$code`.
     */
    public static function budget(mixed $value, RejectionCode $code, bool $withCost): Budget
    {
        if (!$value instanceof JsonObject) {
            throw new Rejection($code);
        }
        $keys = $withCost
            ? ['usage', 'period', 'reserve', ...($value->has('tokens') ? ['tokens'] : []), ...($value->has('cost') ? ['cost'] : [])]
            : ['usage', 'period', 'reserve', 'tokens'];
        $reserve = $value->get('reserve');
        $usage = \is_string($value->get('usage')) ? UsageFormat::tryFrom($value->get('usage')) : null;
        $period = \is_string($value->get('period')) ? QuotaPeriod::tryFrom($value->get('period')) : null;
        $tokens = $value->has('tokens') ? $value->get('tokens') : null;
        if (
            !$value->hasExactKeys(...$keys) || $usage === null || $period === null
            || !\is_int($reserve) || !self::intIn($reserve, 1, UsageFormat::MAX_TOKENS)
            || ($value->has('tokens') && !self::intIn($tokens, 1, Budget::MAX_TOKENS))
            || (!$value->has('tokens') && !$value->has('cost'))
        ) {
            throw new Rejection($code);
        }
        $cost = null;
        if ($value->has('cost')) {
            $entry = $value->get('cost');
            if (!$entry instanceof JsonObject || !$entry->hasExactKeys('limit', 'inputPerMillion', 'outputPerMillion')) {
                throw new Rejection($code);
            }
            $limit = Budget::amount($entry->get('limit'));
            $input = Budget::amount($entry->get('inputPerMillion'));
            $output = Budget::amount($entry->get('outputPerMillion'));
            if (
                $limit === null || $limit < 1 || $limit > Budget::MAX_AMOUNT_MICROS
                || $input === null || $input > Budget::MAX_PRICE_MICROS
                || $output === null || $output > Budget::MAX_PRICE_MICROS
            ) {
                throw new Rejection($code);
            }
            $cost = new Cost($limit, $input, $output);
        }

        return new Budget($usage, $period, $reserve, \is_int($tokens) ? $tokens : null, $cost);
    }

    /** @return list<string> */
    private static function origins(mixed $value): array
    {
        if (!\is_array($value) || !array_is_list($value) || \count($value) > self::MAX_ORIGINS) {
            self::fail();
        }
        $origins = [];
        foreach ($value as $origin) {
            if (!\is_string($origin) || !self::isWebOrigin($origin)) {
                self::fail();
            }
            $origins[] = $origin;
        }

        return $origins;
    }

    private static function routeLimit(mixed $value): RouteLimit
    {
        if (!$value instanceof JsonObject || !$value->hasExactKeys('requests', 'windowSeconds', 'per')) {
            self::fail();
        }
        $per = \is_string($value->get('per')) ? LimitScope::tryFrom($value->get('per')) : null;

        return new RouteLimit(self::limit($value, RejectionCode::ConfigInvalid), $per ?? self::fail());
    }

    /** `{requests, period}` of a quota (route or policy, FR-31); else a Rejection with `$code`. */
    public static function quota(mixed $value, RejectionCode $code): Quota
    {
        if (!$value instanceof JsonObject || !$value->hasExactKeys('requests', 'period')) {
            throw new Rejection($code);
        }
        $requests = $value->get('requests');
        $period = \is_string($value->get('period')) ? QuotaPeriod::tryFrom($value->get('period')) : null;
        if (!\is_int($requests) || !self::intIn($requests, 1, Limit::MAX_REQUESTS) || $period === null) {
            throw new Rejection($code);
        }

        return new Quota($requests, $period);
    }

    /** `requests` and `windowSeconds` of a limit object (route or policy); else a Rejection with `$code`. */
    public static function limit(JsonObject $value, RejectionCode $code): Limit
    {
        $requests = $value->get('requests');
        $window = $value->get('windowSeconds');
        if (!\is_int($requests) || !self::intIn($requests, 1, Limit::MAX_REQUESTS) || !\is_int($window) || !self::intIn($window, 1, Limit::MAX_WINDOW_SECONDS)) {
            throw new Rejection($code);
        }

        return new Limit($requests, $window);
    }

    /**
     * A browser origin as isWebOrigin() in libs/core: an HTTPS origin as isOrigin(), or
     * `http://localhost[:port]` / `http://127.0.0.1[:port]` for local development.
     */
    public static function isWebOrigin(string $value): bool
    {
        if (self::isOrigin($value)) {
            return true;
        }
        if (preg_match('~^http://(?:localhost|127\.0\.0\.1)(?::([1-9][0-9]{0,4}))?$~D', $value, $match) !== 1) {
            return false;
        }
        $port = $match[1] ?? null;

        return $port === null || ((int) $port <= 65535 && $port !== '80');
    }

    /** @return list<string> */
    private static function mediaTypes(mixed $value): array
    {
        if (!\is_array($value) || !array_is_list($value) || $value === [] || \count($value) > 8) {
            self::fail();
        }
        $types = [];
        foreach ($value as $type) {
            if (!\is_string($type) || preg_match(ContentType::MEDIA_TYPE, $type) !== 1) {
                self::fail();
            }
            $types[] = $type;
        }

        return $types;
    }

    public static function intIn(mixed $value, int $min, int $max): bool
    {
        return \is_int($value) && $value >= $min && $value <= $max;
    }

    private static function fail(): never
    {
        throw new Rejection(RejectionCode::ConfigInvalid);
    }
}
