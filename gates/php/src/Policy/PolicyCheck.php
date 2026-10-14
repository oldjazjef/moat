<?php

declare(strict_types=1);

namespace Moat\Gate\Policy;

use Moat\Gate\Config\CompiledConfig;
use Moat\Gate\Config\ConfigValidator;
use Moat\Gate\Config\Limit;
use Moat\Gate\Config\LimitScope;
use Moat\Gate\Config\Method;
use Moat\Gate\Http\PathNormaliser;
use Moat\Gate\Json\JsonObject;
use Moat\Gate\Rejection;
use Moat\Gate\RejectionCode;

/**
 * Parses the local policy and checks a config against it, exactly as libs/core does
 * (conformance/vectors/config/policy.json). A config beyond the policy rejects the whole bundle
 * (`policy_violation`, SEC-11); a malformed policy is `policy_invalid` and the gate serves
 * nothing (SEC-46).
 */
final class PolicyCheck
{
    public const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
    /** Bounds of `maxConfigAgeSeconds` (SEC-15): one hour to ten years. */
    public const MIN_CONFIG_AGE = 3_600;
    public const MAX_CONFIG_AGE = 10 * 365 * 86_400;

    public static function parse(mixed $value): Policy
    {
        if (!$value instanceof JsonObject || $value->get('v') !== 1) {
            self::invalid();
        }
        $testing = $value->has('testing');
        $hasMaxAge = $value->has('maxConfigAgeSeconds');
        $hasPull = $value->has('pull');
        if (!$value->hasExactKeys('v', 'upstreams', 'maxBodyBytes', 'maxResponseBytes', 'maxTimeoutMs', 'limits', ...($testing ? ['testing'] : []), ...($hasMaxAge ? ['maxConfigAgeSeconds'] : []), ...($hasPull ? ['pull'] : []))) {
            self::invalid();
        }
        $maxAge = null;
        if ($hasMaxAge) {
            $maxAge = $value->get('maxConfigAgeSeconds');
            if (!\is_int($maxAge) || !ConfigValidator::intIn($maxAge, self::MIN_CONFIG_AGE, self::MAX_CONFIG_AGE)) {
                self::invalid();
            }
        }
        $upstreams = $value->get('upstreams');
        $maxBodyBytes = $value->get('maxBodyBytes');
        $maxResponseBytes = $value->get('maxResponseBytes');
        $maxTimeoutMs = $value->get('maxTimeoutMs');
        if (
            !$upstreams instanceof JsonObject
            || !\is_int($maxBodyBytes) || !ConfigValidator::intIn($maxBodyBytes, 0, ConfigValidator::MAX_BODY_BYTES)
            || !\is_int($maxResponseBytes) || !ConfigValidator::intIn($maxResponseBytes, 1, self::MAX_RESPONSE_BYTES)
            || !\is_int($maxTimeoutMs) || !ConfigValidator::intIn($maxTimeoutMs, 1, ConfigValidator::MAX_TIMEOUT_MS)
        ) {
            self::invalid();
        }
        $allowed = [];
        foreach ($upstreams->keys() as $hostKey) {
            $allowed[self::hostKey($hostKey)] = self::upstream($upstreams->get($hostKey));
        }
        $limits = self::limits($value->get('limits'));
        [$resolve, $caFile] = $testing ? self::testing($value->get('testing')) : [[], null];

        $pull = $hasPull ? self::pull($value->get('pull')) : null;

        return new Policy($allowed, $maxBodyBytes, $maxResponseBytes, $maxTimeoutMs, $limits, $testing, $resolve, $caFile, $maxAge, $pull);
    }

    /**
     * `https://host[:port]/path`: the origin as an upstream's (lower-case DNS name, no IP literal,
     * no `:443`), the path segments of unreserved characters and none `.` or `..` (isPullUrl in
     * libs/core).
     */
    private static function pull(mixed $value): PolicyPull
    {
        if (!$value instanceof JsonObject || !$value->hasExactKeys('url', 'intervalSeconds')) {
            self::invalid();
        }
        $url = $value->get('url');
        $interval = $value->get('intervalSeconds');
        if (
            !\is_string($url) || \strlen($url) > PolicyPull::MAX_URL
            || !\is_int($interval) || !ConfigValidator::intIn($interval, PolicyPull::MIN_INTERVAL, PolicyPull::MAX_INTERVAL)
            || preg_match('#^(https://[^/]+)((?:/[A-Za-z0-9._~-]+)+)$#D', $url, $match) !== 1
            || !ConfigValidator::isOrigin($match[1])
        ) {
            self::invalid();
        }
        foreach (\array_slice(explode('/', $match[2]), 1) as $segment) {
            if ($segment === '.' || $segment === '..') {
                self::invalid();
            }
        }
        $authority = substr($match[1], \strlen('https://'));
        $colon = strrpos($authority, ':');

        return new PolicyPull(
            $colon === false ? $authority : substr($authority, 0, $colon),
            $colon === false ? 443 : (int) substr($authority, $colon + 1),
            $match[2],
            $interval,
        );
    }

    /** Throws `policy_violation` unless every upstream, route and limit lies within the policy. */
    public static function check(CompiledConfig $config, Policy $policy): void
    {
        foreach ($config->upstreams as $upstream) {
            if ($upstream->timeoutMs > $policy->maxTimeoutMs) {
                self::violation();
            }
            // SEC-35: a secret goes only to a host the policy binds it to.
            if ($upstream->auth !== null) {
                $allowed = $policy->upstreams[$upstream->hostKey()] ?? null;
                if ($allowed === null || !\in_array($upstream->auth->secret, $allowed->secrets, true)) {
                    self::violation();
                }
            }
        }
        foreach ($config->routes as $route) {
            $allowed = $policy->upstreams[$config->upstreamOf($route)->hostKey()] ?? null;
            if ($allowed === null || !\in_array($route->method, $allowed->methods, true) || $route->maxBodyBytes > $policy->maxBodyBytes) {
                self::violation();
            }
            $within = false;
            foreach ($allowed->pathPrefixes as $prefix) {
                $within = $within || self::matchesPrefix($route->upstreamPath, $prefix);
            }
            if (!$within) {
                self::violation();
            }
            // Every answer from a host with a budget must be countable, in the policy's format.
            if ($allowed->budget !== null && (
                array_diff($route->responseContentTypes, [ConfigValidator::JSON]) !== []
                || ($route->budget !== null && $route->budget->usage !== $allowed->budget->usage)
            )) {
                self::violation();
            }
        }
        if (self::counterCapacity($config, $policy) > $policy->limits->maxClients) {
            self::violation();
        }
    }

    /**
     * SEC-27: the most rate-limit counters alive at once, as counterCapacity() in libs/core — a
     * counter is created only for a request that passes `total`, so a flood cannot fill the store.
     */
    public static function counterCapacity(CompiledConfig $config, Policy $policy): int
    {
        $total = $policy->limits->total;
        $live = static fn(int $window): int => $total->requests * (intdiv($window + $total->windowSeconds - 1, $total->windowSeconds) + 1);
        $count = 1 + $live($policy->limits->perIp->windowSeconds) + ($policy->limits->quota !== null ? 1 : 0);
        foreach ($config->routes as $route) {
            if ($route->quota !== null) {
                ++$count;
            }
            if ($route->rateLimit !== null) {
                $count += $route->rateLimit->per === LimitScope::Ip ? $live($route->rateLimit->limit->windowSeconds) : 1;
            }
        }

        return $count;
    }

    /** True when `path` equals the prefix or continues it at a segment boundary. */
    public static function matchesPrefix(string $path, string $prefix): bool
    {
        if ($prefix === '/' || $path === $prefix) {
            return true;
        }

        return str_starts_with($path, str_ends_with($prefix, '/') ? $prefix : $prefix . '/');
    }

    private static function hostKey(string $key): string
    {
        if (!ConfigValidator::isOrigin('https://' . $key)) {
            self::invalid();
        }

        return $key;
    }

    private static function upstream(mixed $entry): PolicyUpstream
    {
        if (!$entry instanceof JsonObject || !$entry->hasExactKeys('pathPrefixes', 'methods', 'secrets', ...($entry->has('budget') ? ['budget'] : []))) {
            self::invalid();
        }
        $prefixes = $entry->get('pathPrefixes');
        $methods = $entry->get('methods');
        $names = $entry->get('secrets');
        if (
            !\is_array($prefixes) || !array_is_list($prefixes) || $prefixes === [] || \count($prefixes) > 64
            || !\is_array($methods) || !array_is_list($methods) || $methods === []
            || !\is_array($names) || !array_is_list($names) || \count($names) > 16
        ) {
            self::invalid();
        }
        $pathPrefixes = [];
        foreach ($prefixes as $prefix) {
            if (!\is_string($prefix) || !self::isPrefix($prefix)) {
                self::invalid();
            }
            $pathPrefixes[] = $prefix;
        }
        $allowed = [];
        foreach ($methods as $method) {
            $allowed[] = (\is_string($method) ? Method::tryFrom($method) : null) ?? self::invalid();
        }

        $secrets = [];
        foreach ($names as $name) {
            if (!\is_string($name) || preg_match(ConfigValidator::NAME, $name) !== 1) {
                self::invalid();
            }
            $secrets[] = $name;
        }

        $budget = $entry->has('budget') ? ConfigValidator::budget($entry->get('budget'), RejectionCode::PolicyInvalid, false) : null;

        return new PolicyUpstream($pathPrefixes, $allowed, $secrets, $budget);
    }

    private static function isPrefix(string $value): bool
    {
        try {
            return PathNormaliser::normalise($value) === $value;
        } catch (Rejection) {
            return false;
        }
    }

    private static function limits(mixed $value): PolicyLimits
    {
        if (!$value instanceof JsonObject || !$value->hasExactKeys('perIp', 'total', 'maxClients', ...($value->has('quota') ? ['quota'] : []))) {
            self::invalid();
        }
        $maxClients = $value->get('maxClients');
        if (!\is_int($maxClients) || !ConfigValidator::intIn($maxClients, PolicyLimits::MIN_CLIENTS, PolicyLimits::MAX_CLIENTS)) {
            self::invalid();
        }

        return new PolicyLimits(
            self::limit($value->get('perIp')),
            self::limit($value->get('total')),
            $maxClients,
            $value->has('quota') ? ConfigValidator::quota($value->get('quota'), RejectionCode::PolicyInvalid) : null,
        );
    }

    private static function limit(mixed $value): Limit
    {
        if (!$value instanceof JsonObject || !$value->hasExactKeys('requests', 'windowSeconds')) {
            self::invalid();
        }

        return ConfigValidator::limit($value, RejectionCode::PolicyInvalid);
    }

    /** @return array{array<string, string>, ?non-empty-string} */
    private static function testing(mixed $value): array
    {
        if (!$value instanceof JsonObject || !$value->hasExactKeys('resolve', 'caFile')) {
            self::invalid();
        }
        $resolve = $value->get('resolve');
        $caFile = $value->get('caFile');
        if (!$resolve instanceof JsonObject) {
            self::invalid();
        }
        if ($caFile !== null) {
            if (!\is_string($caFile) || $caFile === '' || \strlen($caFile) > 4096) {
                self::invalid();
            }
        }
        $map = [];
        foreach ($resolve->keys() as $hostKey) {
            $ip = $resolve->get($hostKey);
            if (!\is_string($ip) || ($ip !== '127.0.0.1' && $ip !== '::1')) {
                self::invalid();
            }
            $map[self::hostKey($hostKey)] = $ip;
        }

        return [$map, $caFile];
    }

    private static function invalid(): never
    {
        throw new Rejection(RejectionCode::PolicyInvalid);
    }

    private static function violation(): never
    {
        throw new Rejection(RejectionCode::PolicyViolation);
    }
}
