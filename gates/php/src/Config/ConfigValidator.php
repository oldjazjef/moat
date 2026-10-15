<?php

declare(strict_types=1);

namespace Moat\Gate\Config;

use Moat\Gate\Encoding\Base64Url;
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
    /** FR-20: a Basic user name or OAuth2 client id — visible ASCII without ":". */
    private const CREDENTIAL_ID = '/^[\x21-\x39\x3B-\x7E]{1,128}$/D';
    /** RFC 6749 §3.3: scope tokens separated by single spaces. */
    private const OAUTH_SCOPE = '/^[\x21\x23-\x5B\x5D-\x7E]{1,128}(?: [\x21\x23-\x5B\x5D-\x7E]{1,128}){0,15}$/D';
    private const MAX_TOKEN_URL = 512;
    /** FR-16: visible ASCII, for a JWT's issuer and audience. */
    private const VISIBLE = '/^[\x21-\x7E]{1,256}$/D';
    private const MAX_JWT_KEYS = 8;
    /** Headers a client check may not read (RESERVED in libs/core http/client.ts). */
    private const CLIENT_RESERVED = [
        'host', 'content-type', 'content-length', 'transfer-encoding', 'connection', 'origin', 'cookie',
        'access-control-request-method', 'access-control-request-headers',
    ];
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
            // FR-16: the checks' secrets are in the bundle; an API key is compared, never sent, so
            // it is no upstream's or Turnstile's secret.
            $client = $route->client;
            if ($client !== null) {
                foreach ($client->secrets() as $secret) {
                    if (!\in_array($secret, $secretNames, true)) {
                        self::fail();
                    }
                }
                $apiKey = $client->apiKey[1] ?? null;
                if ($apiKey !== null && ($apiKey === ($client->turnstile[1] ?? null) || array_filter($upstreams, static fn(Upstream $upstream): bool => $upstream->auth?->secret === $apiKey) !== [])) {
                    self::fail();
                }
            }
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
            AuthType::Basic => $value->hasExactKeys('type', 'username', 'secret')
                && \is_string($name = $value->get('username'))
                && preg_match(self::CREDENTIAL_ID, $name) === 1,
            AuthType::OAuth2 => ($value->has('scope') ? $value->hasExactKeys('type', 'tokenUrl', 'clientId', 'scope', 'secret') : $value->hasExactKeys('type', 'tokenUrl', 'clientId', 'secret'))
                && \is_string($name = $value->get('clientId'))
                && preg_match(self::CREDENTIAL_ID, $name) === 1,
        };
        if (!$valid || !\is_string($secret) || preg_match(self::NAME, $secret) !== 1 || !\is_string($name)) {
            self::fail();
        }

        if ($type === AuthType::OAuth2 && $value->has('scope') && (!\is_string($value->get('scope')) || preg_match(self::OAUTH_SCOPE, $value->get('scope')) !== 1)) {
            self::fail();
        }
        $scope = $value->has('scope') && \is_string($value->get('scope')) ? $value->get('scope') : null;

        return new Auth($type, $name, $secret, $type === AuthType::OAuth2 ? self::endpoint($value->get('tokenUrl'), $scope) : null);
    }

    /** FR-20, FR-16: an HTTPS origin and a path of plain segments (isTokenUrl in libs/core). */
    private static function endpoint(mixed $url, ?string $scope): TokenEndpoint
    {
        if (
            !\is_string($url) || \strlen($url) > self::MAX_TOKEN_URL
            || preg_match('#^(https://[^/]+)((?:/[A-Za-z0-9._~-]+)+)$#D', $url, $match) !== 1
            || !self::isOrigin($match[1])
        ) {
            self::fail();
        }
        foreach (\array_slice(explode('/', $match[2]), 1) as $segment) {
            if ($segment === '.' || $segment === '..') {
                self::fail();
            }
        }

        return new TokenEndpoint($match[1], $match[2], $scope);
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
            ...($value->has('body') ? ['body'] : []),
            ...($value->has('client') ? ['client'] : []),
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
        $contentTypes = self::mediaTypes($value->get('contentTypes'));
        // FR-13: body fields only where a JSON body is sent, and only JSON.
        $body = $value->has('body') ? BodySchema::parse($value->get('body')) : null;
        if ($body !== null && (!\in_array($method, [Method::Post, Method::Put, Method::Patch], true) || $contentTypes !== [self::JSON])) {
            self::fail();
        }
        $client = $value->has('client') ? self::client($value->get('client')) : null;
        // FR-16: the JWT has Authorization to itself; a honeypot needs a JSON body.
        if ($client !== null && (
            ($client->jwt !== null && strtolower($client->apiKey[0] ?? '') === 'authorization')
            || ($client->honeypot !== null && (!\in_array($method, [Method::Post, Method::Put, Method::Patch], true) || $contentTypes !== [self::JSON]))
        )) {
            self::fail();
        }

        return new Route(
            $name,
            $method,
            $path,
            $upstream,
            $upstreamPath,
            $maxBodyBytes,
            $contentTypes,
            $responseTypes,
            $enabled,
            self::origins($value->get('origins')),
            $value->get('rateLimit') === null ? null : self::routeLimit($value->get('rateLimit')),
            $value->has('quota') ? self::quota($value->get('quota'), RejectionCode::ConfigInvalid) : null,
            $budget,
            $body,
            $client,
        );
    }

    /** FR-16, as clientSchemaWith in libs/core/src/http/client.ts. */
    private static function client(mixed $value): ClientProtection
    {
        if (!$value instanceof JsonObject || $value->members() === []) {
            self::fail();
        }
        $known = ['apiKey', 'jwt', 'turnstile', 'honeypot'];
        if (array_diff(array_keys($value->members()), $known) !== []) {
            self::fail();
        }
        $apiKey = null;
        if ($value->has('apiKey')) {
            $entry = $value->get('apiKey');
            if (!$entry instanceof JsonObject || !$entry->hasExactKeys('header', 'secret')) {
                self::fail();
            }
            $apiKey = [self::clientHeader($entry->get('header')), self::secretName($entry->get('secret'))];
        }
        $jwt = $value->has('jwt') ? self::jwt($value->get('jwt')) : null;
        $turnstile = null;
        if ($value->has('turnstile')) {
            $entry = $value->get('turnstile');
            if (!$entry instanceof JsonObject || !$entry->hasExactKeys('header', 'secret', 'verifyUrl')) {
                self::fail();
            }
            $turnstile = [self::clientHeader($entry->get('header')), self::secretName($entry->get('secret')), self::endpoint($entry->get('verifyUrl'), null)];
        }
        $honeypot = null;
        if ($value->has('honeypot')) {
            $entry = $value->get('honeypot');
            $field = $entry instanceof JsonObject && $entry->hasExactKeys('field') ? $entry->get('field') : null;
            if (!\is_string($field) || preg_match('/^[A-Za-z_][A-Za-z0-9_]{0,63}$/D', $field) !== 1) {
                self::fail();
            }
            $honeypot = $field;
        }

        return new ClientProtection($apiKey, $jwt, $turnstile, $honeypot);
    }

    /** @return array{string, string, list<JwtKey>} */
    private static function jwt(mixed $value): array
    {
        if (!$value instanceof JsonObject || !$value->hasExactKeys('issuer', 'audience', 'keys')) {
            self::fail();
        }
        $issuer = $value->get('issuer');
        $audience = $value->get('audience');
        $list = $value->get('keys');
        if (
            !\is_string($issuer) || preg_match(self::VISIBLE, $issuer) !== 1
            || !\is_string($audience) || preg_match(self::VISIBLE, $audience) !== 1
            || !\is_array($list) || !array_is_list($list) || $list === [] || \count($list) > self::MAX_JWT_KEYS
        ) {
            self::fail();
        }
        $keys = [];
        foreach ($list as $entry) {
            if (!$entry instanceof JsonObject || !$entry->hasExactKeys('kid', 'alg', 'spki')) {
                self::fail();
            }
            $kid = $entry->get('kid');
            $alg = \is_string($entry->get('alg')) ? JwtAlg::tryFrom($entry->get('alg')) : null;
            $spki = $entry->get('spki');
            if (!\is_string($kid) || preg_match('/^[A-Za-z0-9._-]{1,128}$/D', $kid) !== 1 || isset($keys[$kid]) || $alg === null || !\is_string($spki) || \strlen($spki) > 1500) {
                self::fail();
            }
            try {
                $der = Base64Url::decode($spki);
            } catch (Rejection) {
                self::fail();
            }
            if (!self::isSpkiFor($alg, $der)) {
                self::fail();
            }
            $keys[$kid] = new JwtKey($kid, $alg, $der);
        }

        return [$issuer, $audience, array_values($keys)];
    }

    /** DER SubjectPublicKeyInfo of the algorithm, as isSpkiFor in libs/core. */
    private static function isSpkiFor(JwtAlg $alg, string $der): bool
    {
        return match ($alg) {
            JwtAlg::EdDSA => \strlen($der) === 44 && bin2hex(substr($der, 0, 12)) === '302a300506032b6570032100',
            JwtAlg::ES256 => \strlen($der) === 91 && bin2hex(substr($der, 0, 27)) === '3059301306072a8648ce3d020106082a8648ce3d03010703420004',
            JwtAlg::RS256 => \strlen($der) >= 290 && \strlen($der) <= 1100 && $der[0] === "\x30",
        };
    }

    private static function clientHeader(mixed $value): string
    {
        if (!\is_string($value) || preg_match(self::HEADER_NAME, $value) !== 1 || \in_array(strtolower($value), self::CLIENT_RESERVED, true)) {
            self::fail();
        }

        return $value;
    }

    private static function secretName(mixed $value): string
    {
        if (!\is_string($value) || preg_match(self::NAME, $value) !== 1) {
            self::fail();
        }

        return $value;
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
            ? ['usage', 'period', 'maxOutputTokens', ...($value->has('tokens') ? ['tokens'] : []), ...($value->has('cost') ? ['cost'] : [])]
            : ['usage', 'period', 'maxOutputTokens', 'tokens'];
        $maxOutputTokens = $value->get('maxOutputTokens');
        $usage = \is_string($value->get('usage')) ? UsageFormat::tryFrom($value->get('usage')) : null;
        $period = \is_string($value->get('period')) ? QuotaPeriod::tryFrom($value->get('period')) : null;
        $tokens = $value->has('tokens') ? $value->get('tokens') : null;
        if (
            !$value->hasExactKeys(...$keys) || $usage === null || $period === null
            || !\is_int($maxOutputTokens) || !self::intIn($maxOutputTokens, 1, UsageFormat::MAX_TOKENS)
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

        return new Budget($usage, $period, $maxOutputTokens, \is_int($tokens) ? $tokens : null, $cost);
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
