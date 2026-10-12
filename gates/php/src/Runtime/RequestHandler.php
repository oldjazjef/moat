<?php

declare(strict_types=1);

namespace Moat\Gate\Runtime;

use Moat\Gate\Config\AuthType;
use Moat\Gate\Config\Method;
use Moat\Gate\Config\Route;
use Moat\Gate\Http\ContentType;
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
 * One client request → at most one upstream call. Path normalised before matching, exact route
 * match (SEC-42), body size and content type checked before anything leaves (FR-18), the secret
 * opened only for this call and wiped after (SEC-35), and the answer reduced to status, media
 * type and body. Anything unexpected ends in a generic error (SEC-46).
 */
final class RequestHandler
{
    public static function handle(Request $request, ActiveBundle $bundle, Gate $gate): Response
    {
        try {
            return self::forward($request, $bundle, $gate);
        } catch (Failure $failure) {
            if ($failure->error->status() >= 500) {
                Kernel::log(null, $failure->error->value);
            }

            return Response::error($failure->error, $failure->allow);
        }
    }

    private static function forward(Request $request, ActiveBundle $bundle, Gate $gate): Response
    {
        $route = self::match($request, $bundle);
        $upstream = $bundle->config->upstreamOf($route);
        $maxBody = min($route->maxBodyBytes, $bundle->policy->maxBodyBytes);
        $body = $request->body($maxBody);
        $hasBody = $body !== '' || \in_array($route->method, [Method::Post, Method::Put, Method::Patch], true);
        $mediaType = $request->contentType === null ? null : ContentType::mediaTypeOf($request->contentType);
        if ($hasBody && ($mediaType === null || !\in_array($mediaType, $route->contentTypes, true))) {
            throw new Failure(GateError::UnsupportedMediaType);
        }

        $headers = ['Accept' => implode(', ', $route->responseContentTypes)];
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
            if ($secret !== '' && (str_contains($response->body, $secret) || str_contains($response->body, rawurlencode($secret)))) {
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

    /** Exact match on the normalised path; 405 with Allow when only the method differs. */
    private static function match(Request $request, ActiveBundle $bundle): Route
    {
        if ($request->rawPath === null) {
            throw new Failure(GateError::NotFound);
        }
        try {
            $path = PathNormaliser::normalise($request->rawPath);
        } catch (Rejection) {
            throw new Failure(GateError::PathInvalid);
        }
        $allow = [];
        foreach ($bundle->config->routes as $route) {
            if ($route->path !== $path) {
                continue;
            }
            if ($route->method->value === $request->method) {
                if (!$route->enabled) {
                    throw new Failure(GateError::RouteDisabled);
                }

                return $route;
            }
            $allow[] = $route->method->value;
        }
        if ($allow === []) {
            throw new Failure(GateError::NotFound);
        }
        sort($allow);

        throw new Failure(GateError::MethodNotAllowed, $allow);
    }
}
