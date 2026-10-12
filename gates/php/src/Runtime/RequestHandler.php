<?php

declare(strict_types=1);

namespace Moat\Gate\Runtime;

use Moat\Gate\Config\AuthType;
use Moat\Gate\Config\LimitScope;
use Moat\Gate\Config\Method;
use Moat\Gate\Config\Route;
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
            $response = self::forward($request, $route, $bundle, $gate);

            return new Response($response->status, $response->headers + $cors, $response->body);
        } catch (Failure $failure) {
            throw $failure->with($cors);
        }
    }

    /** FR-30, SEC-45: the policy's limits always, the route's own on top; 429 with Retry-After. */
    private static function limit(Request $request, Route $route, ActiveBundle $bundle, Gate $gate, int $now): void
    {
        $client = ClientKey::of($request->remoteAddr) ?? throw new Failure(GateError::RateLimitUnavailable);
        $limits = $bundle->policy->limits;
        $counters = [['ip ' . $client, $limits->perIp], ['total', $limits->total]];
        if ($route->rateLimit !== null) {
            $scope = $route->rateLimit->per === LimitScope::Ip ? $client : '*';
            $counters[] = ['route ' . $route->name . ' ' . $scope, $route->rateLimit->limit];
        }
        try {
            $retryAfter = RateLimiter::hit($gate->data, $counters, $limits->maxClients, $now);
        } catch (\Exception) {
            // Store full, damaged, locked too long or not writable: fail closed (SEC-27, SEC-46).
            throw new Failure(GateError::RateLimitUnavailable);
        }
        if ($retryAfter !== null) {
            throw new Failure(GateError::RateLimited, ['Retry-After' => (string) $retryAfter]);
        }
    }

    private static function forward(Request $request, Route $route, ActiveBundle $bundle, Gate $gate): Response
    {
        $upstream = $bundle->config->upstreamOf($route);
        $maxBody = min($route->maxBodyBytes, $bundle->policy->maxBodyBytes);
        $body = $request->body($maxBody);
        $hasBody = $body !== '' || \in_array($route->method, [Method::Post, Method::Put, Method::Patch], true);
        $mediaType = $request->contentType === null ? null : ContentType::mediaTypeOf($request->contentType);
        if ($hasBody && ($mediaType === null || !\in_array($mediaType, $route->contentTypes, true))) {
            throw new Failure(GateError::UnsupportedMediaType);
        }

        $headers = ['Accept' => implode(', ', $route->responseContentTypes)];
        if ($hasBody) {
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
