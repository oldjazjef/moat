<?php

declare(strict_types=1);

namespace Moat\Gate\Runtime;

use Moat\Gate\Config\Auth;
use Moat\Gate\Http\Failure;
use Moat\Gate\Http\GateError;
use Moat\Gate\Json\JsonObject;
use Moat\Gate\Json\StrictJson;
use Moat\Gate\Rejection;
use Moat\Gate\Storage\DataDir;
use Moat\Gate\Upstream\UpstreamClient;
use Moat\Gate\Upstream\UpstreamRequest;

/**
 * FR-20, OAuth2 client credentials (RFC 6749 §4.4): the access token for an upstream, fetched
 * with the client id and the secret (client_secret_basic, §2.3.1) through the one cURL client and
 * cached in the data file `tokens` until shortly before it expires. The cache holds only access
 * tokens, never the secret; it sits next to `identity`, whose key opens every secret, so it needs
 * no extra encryption. A cached token belongs to one bundle version and one upstream's settings.
 */
final class OAuthToken
{
    public const FILE = 'tokens';
    /** A token is used until this many seconds before it expires. */
    private const MARGIN = 30;
    /** And never longer than this, whatever the provider says. */
    private const MAX_LIFETIME = 3600;
    /** Without `expires_in`: assume this. */
    private const DEFAULT_LIFETIME = 300;
    private const MAX_TOKEN = 4096;
    private const MAX_ENTRIES = 64;

    /** The cached token, or a new one from the token endpoint. Throws `upstream_auth_failed`. */
    public static function get(DataDir $data, string $key, Auth $auth, string $secret, ActiveBundle $bundle, int $now): string
    {
        $cached = self::cached($data, $key, $now);
        if ($cached !== null) {
            return $cached;
        }
        [$token, $lifetime] = self::fetch($auth, $secret, $bundle);
        if ($lifetime > 0) {
            self::store($data, $key, $token, $now + $lifetime, $now);
        }

        return $token;
    }

    /** After the API answered 401: the token is not used again. */
    public static function drop(DataDir $data, string $key): void
    {
        try {
            $data->locked(static function () use ($data, $key): void {
                $entries = self::entries($data);
                if (isset($entries[$key])) {
                    unset($entries[$key]);
                    self::write($data, $entries);
                }
            }, self::FILE . 'lock');
        } catch (\RuntimeException) {
            // A cache that cannot be written is only a cache.
        }
    }

    /** The cache key: the bundle version and every setting that makes the token. */
    public static function key(string $upstream, Auth $auth, int $version): string
    {
        $token = $auth->token ?? throw new \LogicException('not oauth2');

        return hash('sha256', implode("\n", [(string) $version, $upstream, $token->url(), $auth->name, $token->scope ?? '', $auth->secret]));
    }

    private static function cached(DataDir $data, string $key, int $now): ?string
    {
        try {
            $entry = self::entries($data)[$key] ?? null;
        } catch (\RuntimeException) {
            return null;
        }

        return $entry !== null && $entry[1] > $now ? $entry[0] : null;
    }

    /** @return array{string, int} the token and how long to keep it */
    private static function fetch(Auth $auth, string $secret, ActiveBundle $bundle): array
    {
        $endpoint = $auth->token ?? throw new Failure(GateError::UpstreamAuthFailed);
        $credential = 'Basic ' . base64_encode(urlencode($auth->name) . ':' . urlencode($secret));
        $body = 'grant_type=client_credentials' . ($endpoint->scope === null ? '' : '&scope=' . rawurlencode($endpoint->scope));
        try {
            $response = UpstreamClient::send(new UpstreamRequest(
                'POST',
                $endpoint->host(),
                $endpoint->port(),
                $endpoint->path,
                ['Accept' => 'application/json', 'Content-Type' => 'application/x-www-form-urlencoded', 'Authorization' => $credential],
                $body,
                $bundle->policy->maxTimeoutMs,
                min(self::MAX_TOKEN * 4, $bundle->policy->maxResponseBytes),
                ['application/json'],
            ), $bundle->policy);
        } catch (Failure) {
            throw new Failure(GateError::UpstreamAuthFailed);
        } finally {
            sodium_memzero($credential);
        }

        return self::parse($response->status, $response->body);
    }

    /** @return array{string, int} */
    private static function parse(int $status, string $body): array
    {
        try {
            $answer = $status === 200 ? StrictJson::decode($body) : null;
        } catch (Rejection) {
            $answer = null;
        }
        if (!$answer instanceof JsonObject) {
            throw new Failure(GateError::UpstreamAuthFailed);
        }
        $token = $answer->get('access_token');
        $type = $answer->get('token_type');
        $expires = $answer->has('expires_in') ? $answer->get('expires_in') : self::DEFAULT_LIFETIME;
        if (
            !\is_string($token) || \strlen($token) > self::MAX_TOKEN
            || preg_match('/^[\x21-\x7E]+$/D', $token) !== 1
            || !\is_string($type) || strtolower($type) !== 'bearer'
            || !\is_int($expires) || $expires < 1
        ) {
            throw new Failure(GateError::UpstreamAuthFailed);
        }

        return [$token, min($expires - self::MARGIN, self::MAX_LIFETIME)];
    }

    private static function store(DataDir $data, string $key, string $token, int $expires, int $now): void
    {
        try {
            $data->locked(static function () use ($data, $key, $token, $expires, $now): void {
                $entries = array_filter(self::entries($data), static fn(array $entry): bool => $entry[1] > $now);
                $entries[$key] = [$token, $expires];
                self::write($data, \array_slice($entries, -self::MAX_ENTRIES, null, true));
            }, self::FILE . 'lock');
        } catch (\RuntimeException) {
            // Not cached: the next request fetches again.
        }
    }

    /** @return array<string, array{string, int}> */
    private static function entries(DataDir $data): array
    {
        $text = $data->read(self::FILE);
        if ($text === null) {
            return [];
        }
        try {
            $value = StrictJson::decode($text);
        } catch (Rejection) {
            return [];
        }
        $entries = [];
        $list = $value instanceof JsonObject ? $value->get('entries') : null;
        if ($list instanceof JsonObject) {
            foreach ($list->members() as $key => $entry) {
                if (
                    preg_match('/^[0-9a-f]{64}$/D', $key) === 1 && $entry instanceof JsonObject
                    && \is_string($entry->get('token')) && \is_int($entry->get('expires'))
                ) {
                    $entries[$key] = [$entry->get('token'), $entry->get('expires')];
                }
            }
        }

        return $entries;
    }

    /** @param array<string, array{string, int}> $entries */
    private static function write(DataDir $data, array $entries): void
    {
        $out = [];
        foreach ($entries as $key => [$token, $expires]) {
            $out[$key] = ['token' => $token, 'expires' => $expires];
        }
        $data->write(self::FILE, json_encode(['v' => 1, 'entries' => (object) $out], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES) . "\n");
    }
}
