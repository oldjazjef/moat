<?php

declare(strict_types=1);

namespace Moat\Gate\Http;

/**
 * The closed list of error answers the gate gives a client: `{"error": "<code>"}` with this
 * status, never a detail, an input value or an upstream's error text (SEC-34, SEC-46).
 */
enum GateError: string
{
    case NotFound = 'not_found';
    case MethodNotAllowed = 'method_not_allowed';
    case PathInvalid = 'path_invalid';
    case BodyTooLarge = 'body_too_large';
    case BodyInvalid = 'body_invalid';
    case UnsupportedMediaType = 'unsupported_media_type';
    case OriginForbidden = 'origin_forbidden';
    /** FR-16: an API key, JWT, Turnstile token or honeypot check failed. */
    case ClientUnauthorized = 'client_unauthorized';
    case PreflightRejected = 'preflight_rejected';
    case RateLimited = 'rate_limited';
    case QuotaExceeded = 'quota_exceeded';
    case BudgetExhausted = 'budget_exhausted';
    case RequestUnbounded = 'request_unbounded';
    case RateLimitUnavailable = 'rate_limit_unavailable';
    case RouteDisabled = 'route_disabled';
    case GateDisabled = 'gate_disabled';
    case GateNotConfigured = 'gate_not_configured';
    case SecretUnavailable = 'secret_unavailable';
    case UpstreamForbidden = 'upstream_forbidden';
    case UpstreamUnreachable = 'upstream_unreachable';
    case UpstreamTimeout = 'upstream_timeout';
    case UpstreamRedirect = 'upstream_redirect';
    case UpstreamContentType = 'upstream_content_type';
    case UpstreamTooLarge = 'upstream_too_large';
    case UpstreamReflectedSecret = 'upstream_reflected_secret';
    case UpstreamUsageInvalid = 'upstream_usage_invalid';
    /** FR-20: the OAuth2 token endpoint gave no usable access token. */
    case UpstreamAuthFailed = 'upstream_auth_failed';
    case Internal = 'internal_error';

    public function status(): int
    {
        return match ($this) {
            self::NotFound => 404,
            self::MethodNotAllowed => 405,
            self::ClientUnauthorized => 401,
            self::PathInvalid, self::BodyInvalid, self::RequestUnbounded => 400,
            self::BodyTooLarge => 413,
            self::UnsupportedMediaType => 415,
            self::OriginForbidden, self::PreflightRejected => 403,
            self::RateLimited, self::QuotaExceeded, self::BudgetExhausted => 429,
            self::RouteDisabled, self::GateDisabled, self::GateNotConfigured, self::RateLimitUnavailable => 503,
            self::SecretUnavailable, self::Internal => 500,
            self::UpstreamTimeout => 504,
            self::UpstreamForbidden, self::UpstreamUnreachable, self::UpstreamRedirect,
            self::UpstreamContentType, self::UpstreamTooLarge, self::UpstreamReflectedSecret, self::UpstreamUsageInvalid,
            self::UpstreamAuthFailed => 502,
        };
    }
}
