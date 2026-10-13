<?php

declare(strict_types=1);

namespace Moat\Gate\Runtime;

use Moat\Gate\Config\AuthType;
use Moat\Gate\Config\Budget;
use Moat\Gate\Config\LimitScope;
use Moat\Gate\Config\Method;
use Moat\Gate\Config\Route;
use Moat\Gate\Config\Usage;
use Moat\Gate\Http\ContentType;
use Moat\Gate\Http\Cors;
use Moat\Gate\Http\Failure;
use Moat\Gate\Http\GateError;
use Moat\Gate\Http\PathNormaliser;
use Moat\Gate\Http\Request;
use Moat\Gate\Http\Response;
use Moat\Gate\Kernel;
use Moat\Gate\Rejection;
use Moat\Gate\Upstream\UpstreamClient;
use Moat\Gate\Upstream\UpstreamRequest;

/**
 * One client request → at most one upstream call, in a fixed order (change-gate skill): path
 * normalised before matching, exact route match (SEC-42), then gating — origin (FR-15) and rate
 * limits (FR-30, SEC-45) — then body size and content type (FR-18), then the secret, opened only
 * for this call and wiped after (SEC-35), and the answer reduced to status, media type and body.
 * A CORS preflight is answered by the gate itself and never reaches an upstream. A locked gate
 * (the bundle's `enabled: false`) refuses every request before any of this, with the same answer
 * whatever the method or path, so it reveals no route. Anything unexpected ends in a generic
 * error (SEC-46).
 */
final class RequestHandler
{
    private const PREFLIGHT_VARY = 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers';
    /** Failures before the request could leave the gate: the provider bills nothing. */
    private const NOT_SENT = [GateError::SecretUnavailable, GateError::UpstreamForbidden];

    public static function handle(Request $request, ActiveBundle $bundle, Gate $gate, int $now): Response
    {
        try {
            return self::dispatch($request, $bundle, $gate, $now);
        } catch (Failure $failure) {
            if ($failure->error->status() >= 500) {
                Kernel::log(null, $failure->error->value);
            }

            return Response::error($failure->error, $failure->headers);
        }
    }

    private static function dispatch(Request $request, ActiveBundle $bundle, Gate $gate, int $now): Response
    {
        if (!$bundle->config->enabled) {
            throw new Failure(GateError::GateDisabled);
        }
        $routes = self::routesAt($request, $bundle);
        if ($request->method === 'OPTIONS' && $request->origin !== null && $request->requestMethod !== null) {
            try {
                $headers = Cors::preflight($routes, $request->origin, $request->requestMethod, $request->requestHeaders);
            } catch (Rejection) {
                throw new Failure(GateError::PreflightRejected, ['Vary' => self::PREFLIGHT_VARY]);
            }

            return new Response(204, $headers + ['Vary' => self::PREFLIGHT_VARY], '');
        }
        $route = self::match($request, $routes);
        try {
            $allowOrigin = Cors::check($route, $request->origin, $request->fetchSite);
        } catch (Rejection) {
            throw new Failure(GateError::OriginForbidden, ['Vary' => 'Origin']);
        }
        $cors = $route->origins === [] ? [] : ['Vary' => 'Origin'];
        if ($allowOrigin !== null) {
            $cors = ['Access-Control-Allow-Origin' => $allowOrigin, 'Access-Control-Expose-Headers' => 'Retry-After'] + $cors;
        }
        try {
            self::limit($request, $route, $bundle, $gate, $now);
            $payload = self::payload($request, $route, $bundle);
            $budgets = self::budgets($route, $bundle);
            $response = $budgets === []
                ? self::forward($payload, $route, $bundle, $gate)
                : self::forwardWithin($budgets, $payload, $route, $bundle, $gate, $now);

            return new Response($response->status, $response->headers + $cors, $response->body);
        } catch (Failure $failure) {
            throw $failure->with($cors);
        }
    }

    /**
     * FR-30, FR-31, SEC-45: the policy's limits and quota always, the route's own on top; 429 with
     * Retry-After, `quota_exceeded` when a full quota is among the reasons.
     */
    private static function limit(Request $request, Route $route, ActiveBundle $bundle, Gate $gate, int $now): void
    {
        $client = ClientKey::of($request->remoteAddr) ?? throw new Failure(GateError::RateLimitUnavailable);
        $limits = $bundle->policy->limits;
        $counters = [['ip ' . $client, $limits->perIp], ['total', $limits->total]];
        if ($route->rateLimit !== null) {
            $scope = $route->rateLimit->per === LimitScope::Ip ? $client : '*';
            $counters[] = ['route ' . $route->name . ' ' . $scope, $route->rateLimit->limit, true];
        }
        if ($limits->quota !== null) {
            $counters[] = ['quota ' . $limits->quota->period->value, $limits->quota];
        }
        if ($route->quota !== null) {
            $counters[] = ['quota route ' . $route->name . ' ' . $route->quota->period->value, $route->quota, true];
        }
        try {
            $refusal = RateLimiter::hit($gate->data, $counters, $limits->maxClients, $now, RateLimiter::routeLimitsId($bundle->config->routes));
        } catch (\Exception) {
            // Store full, damaged, locked too long or not writable: fail closed (SEC-27, SEC-46).
            throw new Failure(GateError::RateLimitUnavailable);
        }
        if ($refusal !== null) {
            throw new Failure($refusal->quota ? GateError::QuotaExceeded : GateError::RateLimited, ['Retry-After' => (string) $refusal->retryAfter]);
        }
    }

    /**
     * FR-31, SEC-14: the budgets this request counts against — the local policy's for the
     * upstream host, whatever the bundle says, and the route's own — with the usage format to read
     * (the policy's when it has one; checkPolicy() made them agree).
     *
     * @return list<array{string, Budget}>
     */
    private static function budgets(Route $route, ActiveBundle $bundle): array
    {
        $budgets = [];
        $hostKey = $bundle->config->upstreamOf($route)->hostKey();
        $host = $bundle->policy->upstreams[$hostKey]->budget ?? null;
        if ($host !== null) {
            $budgets[] = [BudgetStore::hostName($hostKey, $host), $host];
        }
        if ($route->budget !== null) {
            $budgets[] = [BudgetStore::routeName($route->name, $route->budget), $route->budget];
        }

        return $budgets;
    }

    /**
     * FR-31, T-07: forwards within the budgets. The request must bound its cost (no stream, one
     * answer, an output cap of at most `maxOutputTokens`), else 400 `request_unbounded`; its
     * estimate (body bytes as input plus that cap) is then added to every budget — or the request
     * is refused with 429 `budget_exhausted` and Retry-After once a period has spent its tokens or
     * cost, the estimates of requests in flight included. After the answer the estimate is
     * replaced by the usage a 2xx answer reports. It stays charged whenever the request may have
     * reached the provider but its answer cannot be counted (a timeout, too large, not JSON, no
     * usage, a broken connection), and is released for an error answer or a request that never
     * left. A 2xx answer without readable usage is not passed on (`upstream_usage_invalid`, SEC-46).
     *
     * @param non-empty-list<array{string, Budget}> $budgets
     * @param array{string, bool, ?string} $payload
     */
    private static function forwardWithin(array $budgets, array $payload, Route $route, ActiveBundle $bundle, Gate $gate, int $now): Response
    {
        $maxOutput = min(array_map(static fn(array $entry): int => $entry[1]->maxOutputTokens, $budgets));
        $estimate = $budgets[0][1]->usage->estimate($payload[0], $maxOutput) ?? throw new Failure(GateError::RequestUnbounded);
        try {
            [$retryAfter, $resetAts] = BudgetStore::reserve($gate->data, $budgets, $estimate, $now, BudgetStore::routeBudgets($bundle->config->routes));
        } catch (\Exception) {
            throw new Failure(GateError::RateLimitUnavailable);
        }
        if ($retryAfter !== null) {
            throw new Failure(GateError::BudgetExhausted, ['Retry-After' => (string) max(1, $retryAfter)]);
        }
        $settle = static function (?Usage $usage) use ($budgets, $resetAts, $estimate, $gate, $now): void {
            $charges = array_map(static fn(array $entry): array => $usage === null ? [0, 0] : $entry[1]->charge($usage), $budgets);
            try {
                BudgetStore::settle($gate->data, $budgets, $resetAts, $estimate, $charges, $now);
            } catch (\Exception) {
                throw new Failure(GateError::RateLimitUnavailable);
            }
        };
        try {
            $response = self::forward($payload, $route, $bundle, $gate);
        } catch (Failure $failure) {
            // Not sent: nothing to pay. Anything else may have reached the provider and been
            // billed: the estimate stays charged.
            $settle(\in_array($failure->error, self::NOT_SENT, true) ? null : $estimate);

            throw $failure;
        }
        if ($response->status < 200 || $response->status >= 300) {
            $settle(null);

            return $response;
        }
        $usage = $budgets[0][1]->usage->read($response->body);
        $settle($usage ?? $estimate);
        if ($usage === null) {
            throw new Failure(GateError::UpstreamUsageInvalid);
        }

        return $response;
    }

    /**
     * The request's body (FR-18): within the size limits, and of an allowed media type when there
     * is one.
     *
     * @return array{string, bool, ?string} body, whether it is sent, its media type
     */
    private static function payload(Request $request, Route $route, ActiveBundle $bundle): array
    {
        $body = $request->body(min($route->maxBodyBytes, $bundle->policy->maxBodyBytes));
        $hasBody = $body !== '' || \in_array($route->method, [Method::Post, Method::Put, Method::Patch], true);
        $mediaType = $request->contentType === null ? null : ContentType::mediaTypeOf($request->contentType);
        if ($hasBody && ($mediaType === null || !\in_array($mediaType, $route->contentTypes, true))) {
            throw new Failure(GateError::UnsupportedMediaType);
        }

        return [$body, $hasBody, $mediaType];
    }

    /** @param array{string, bool, ?string} $payload */
    private static function forward(array $payload, Route $route, ActiveBundle $bundle, Gate $gate): Response
    {
        $upstream = $bundle->config->upstreamOf($route);
        [$body, $hasBody, $mediaType] = $payload;

        $headers = ['Accept' => implode(', ', $route->responseContentTypes)];
        // payload() refuses a body without a media type.
        if ($hasBody && $mediaType !== null) {
            $headers['Content-Type'] = $mediaType;
        }
        $pathAndQuery = $route->upstreamPath;
        $secret = '';
        try {
            if ($upstream->auth !== null) {
                try {
                    $secret = $gate->openSecret($bundle, $upstream->auth->secret);
                } catch (Rejection) {
                    throw new Failure(GateError::SecretUnavailable);
                }
                if ($upstream->auth->type === AuthType::Bearer) {
                    $headers['Authorization'] = 'Bearer ' . $secret;
                } elseif ($upstream->auth->type === AuthType::Header) {
                    $headers[$upstream->auth->name] = $secret;
                } else {
                    $pathAndQuery .= '?' . rawurlencode($upstream->auth->name) . '=' . rawurlencode($secret);
                }
            }
            $response = UpstreamClient::send(new UpstreamRequest(
                $route->method->value,
                $upstream->host(),
                $upstream->port(),
                $pathAndQuery,
                $headers,
                $body,
                min($upstream->timeoutMs, $bundle->policy->maxTimeoutMs),
                $bundle->policy->maxResponseBytes,
                $route->responseContentTypes,
            ), $bundle->policy);
            // SEC-34: an upstream that echoes the credential does not get it to the client.
            if (SecretEcho::found($response->body, $secret)) {
                throw new Failure(GateError::UpstreamReflectedSecret);
            }
        } finally {
            sodium_memzero($secret);
            foreach ($headers as $name => $value) {
                sodium_memzero($headers[$name]);
            }
            sodium_memzero($pathAndQuery);
        }

        return new Response($response->status, $response->mediaType === null ? [] : ['Content-Type' => $response->mediaType], $response->body);
    }

    /**
     * The routes whose path equals the normalised request path exactly; 404 when there is none.
     *
     * @return non-empty-list<Route>
     */
    private static function routesAt(Request $request, ActiveBundle $bundle): array
    {
        if ($request->rawPath === null) {
            throw new Failure(GateError::NotFound);
        }
        try {
            $path = PathNormaliser::normalise($request->rawPath);
        } catch (Rejection) {
            throw new Failure(GateError::PathInvalid);
        }
        $routes = [];
        foreach ($bundle->config->routes as $route) {
            if ($route->path === $path) {
                $routes[] = $route;
            }
        }

        return $routes === [] ? throw new Failure(GateError::NotFound) : $routes;
    }

    /**
     * The route for the request's method; 405 with Allow when only the method differs.
     *
     * @param non-empty-list<Route> $routes
     */
    private static function match(Request $request, array $routes): Route
    {
        $allow = [];
        foreach ($routes as $route) {
            if ($route->method->value === $request->method) {
                if (!$route->enabled) {
                    throw new Failure(GateError::RouteDisabled);
                }

                return $route;
            }
            $allow[] = $route->method->value;
        }
        sort($allow);

        throw new Failure(GateError::MethodNotAllowed, ['Allow' => implode(', ', $allow)]);
    }
}
