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
        if (!$config instanceof JsonObject || !$config->hasExactKeys('version', 'upstreams', 'routes') || $config->get('version') !== 1) {
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

        return new CompiledConfig($upstreams, $routes);
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
            null => false,
        };
        if (!$valid || $type === null || !\is_string($secret) || preg_match(self::NAME, $secret) !== 1 || !\is_string($name)) {
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

        return new Route(
            $name,
            $method,
            $path,
            $upstream,
            $upstreamPath,
            $maxBodyBytes,
            self::mediaTypes($value->get('contentTypes')),
            self::mediaTypes($value->get('responseContentTypes')),
            $enabled,
        );
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
