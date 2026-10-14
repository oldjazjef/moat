<?php

declare(strict_types=1);

namespace Moat\Gate\Upstream;

use Moat\Gate\Http\ContentType;
use Moat\Gate\Http\Failure;
use Moat\Gate\Http\GateError;
use Moat\Gate\Policy\Policy;

/**
 * The one HTTP client of the gate (CLAUDE.md, PHP standards; SEC-41 to SEC-44): HTTPS only, the
 * checked address pinned, no proxy from the environment, no redirects, TLS verification always
 * on, connect and total timeouts, a response size limit, and only the response's media type kept.
 */
final class UpstreamClient
{
    public const USER_AGENT = 'moat-gate';
    private const MAX_HEADER_BYTES = 64 * 1024;

    public const PROBE_TIMEOUT_MS = 10000;
    public const PROBE_MAX_BYTES = 64 * 1024;
    /** DT-11: a pull holds up one request at most this long. */
    public const PULL_TIMEOUT_MS = 5000;

    public static function send(UpstreamRequest $request, Policy $policy): UpstreamResponse
    {
        $headers = [];
        foreach ($request->headers as $name => $value) {
            if (preg_match('/[\r\n\0]/', $name . $value) === 1) {
                throw new Failure(GateError::Internal);
            }
            $headers[] = $name . ': ' . $value;
        }
        // No "Expect: 100-continue" round trip, and no Content-Type cURL would add on its own.
        $headers[] = 'Expect:';
        if (!isset($request->headers['Content-Type'])) {
            $headers[] = 'Content-Type:';
        }

        $received = new Received();
        [$ok, $errno, $status] = self::exchange($request->host, $request->port, $request->pathAndQuery, $request->method, $headers, $request->body, $request->timeoutMs, $request->maxResponseBytes, $policy, $received);

        if ($received->tooLarge) {
            throw new Failure(GateError::UpstreamTooLarge);
        }
        if ($ok === false || $errno !== 0) {
            throw new Failure($errno === CURLE_OPERATION_TIMEDOUT ? GateError::UpstreamTimeout : GateError::UpstreamUnreachable);
        }
        if ($status < 200 || $status > 599) {
            throw new Failure(GateError::UpstreamUnreachable);
        }
        if ($status >= 300 && $status < 400) {
            throw new Failure(GateError::UpstreamRedirect);
        }
        if ($received->body === '' && $received->contentType === null) {
            return new UpstreamResponse($status, null, '');
        }
        $mediaType = $received->contentType === null ? null : ContentType::mediaTypeOf($received->contentType);
        if ($mediaType === null || !\in_array($mediaType, $request->accept, true)) {
            throw new Failure(GateError::UpstreamContentType);
        }

        return new UpstreamResponse($status, $mediaType, $received->body);
    }

    /**
     * A plain GET for the hardening check from outside (SEC-49): the same address pinning, TLS
     * and protocol rules as send(), no redirect followed, any status accepted, at most
     * PROBE_MAX_BYTES of the body kept. Null when no answer came back.
     *
     * @return ?array{int, string} status and body
     */
    public static function probe(string $host, int $port, string $path, ?Policy $policy): ?array
    {
        if (preg_match('/^\/[\x21-\x7e]*$/D', $path) !== 1) {
            return null;
        }
        $received = new Received();
        try {
            [$ok, $errno, $status] = self::exchange($host, $port, $path, 'GET', ['Expect:'], '', self::PROBE_TIMEOUT_MS, self::PROBE_MAX_BYTES, $policy, $received);
        } catch (Failure) {
            return null;
        }
        if ((!$received->tooLarge && ($ok === false || $errno !== 0)) || $status < 100 || $status > 599) {
            return null;
        }

        return [$status, $received->body];
    }

    /**
     * A GET of the lazy pull (DT-11): the same address pinning, TLS and protocol rules as send(),
     * no redirect followed, at most `$maxBytes` (a larger file is a failure, not cut to fit) and
     * PULL_TIMEOUT_MS. Any status comes back; the caller decides. The body is not trusted:
     * BundleVerifier checks it like any bundle.
     *
     * @return array{int, string}|GateError status and body, or why nothing usable came back
     */
    public static function fetch(string $host, int $port, string $path, int $maxBytes, ?Policy $policy): array|GateError
    {
        $received = new Received();
        try {
            [$ok, $errno, $status] = self::exchange($host, $port, $path, 'GET', ['Expect:', 'Accept: application/json'], '', self::PULL_TIMEOUT_MS, $maxBytes, $policy, $received);
        } catch (Failure $failure) {
            return $failure->error;
        }
        if ($received->tooLarge) {
            return GateError::UpstreamTooLarge;
        }
        if (!$ok || $errno !== 0) {
            return $errno === CURLE_OPERATION_TIMEDOUT ? GateError::UpstreamTimeout : GateError::UpstreamUnreachable;
        }
        if ($status >= 300 && $status < 400) {
            return GateError::UpstreamRedirect;
        }
        if ($status < 200 || $status > 599) {
            return GateError::UpstreamUnreachable;
        }

        return [$status, $received->body];
    }

    /**
     * @param non-empty-string $method
     * @param list<string>     $headers header lines
     *
     * @return array{bool, int, int} cURL's result, its error number and the status
     */
    private static function exchange(string $host, int $port, string $pathAndQuery, string $method, array $headers, string $body, int $timeoutMs, int $maxBytes, ?Policy $policy, Received $received): array
    {
        $address = AddressGuard::resolve($host, $port, $policy);
        $pin = $host . ':' . $port . ':' . (str_contains($address, ':') ? '[' . $address . ']' : $address);
        $url = 'https://' . $host . ($port === 443 ? '' : ':' . $port) . $pathAndQuery;

        $curl = curl_init();
        if ($curl === false) {
            throw new Failure(GateError::Internal);
        }
        $options = [
            CURLOPT_URL => $url,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
            CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTPS,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_RESOLVE => [$pin],
            CURLOPT_PROXY => '',
            CURLOPT_NOPROXY => '*',
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_CONNECTTIMEOUT_MS => min($timeoutMs, 5000),
            CURLOPT_TIMEOUT_MS => $timeoutMs,
            CURLOPT_NOSIGNAL => true,
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_USERAGENT => self::USER_AGENT,
            CURLOPT_HEADERFUNCTION => static function (\CurlHandle $handle, string $line) use ($received): int {
                $received->headerBytes += \strlen($line);
                if ($received->headerBytes > self::MAX_HEADER_BYTES) {
                    return 0;
                }
                if (stripos($line, 'content-type:') === 0) {
                    $received->contentType = trim(substr($line, \strlen('content-type:')), " \t\r\n");
                }

                return \strlen($line);
            },
            CURLOPT_WRITEFUNCTION => static function (\CurlHandle $handle, string $chunk) use ($received, $maxBytes): int {
                if (\strlen($received->body) + \strlen($chunk) > $maxBytes) {
                    $received->body .= substr($chunk, 0, max(0, $maxBytes - \strlen($received->body)));
                    $received->tooLarge = true;

                    return 0;
                }
                $received->body .= $chunk;

                return \strlen($chunk);
            },
        ];
        if ($body !== '') {
            $options[CURLOPT_POSTFIELDS] = $body;
        }
        if ($policy !== null && $policy->testCaFile !== null) {
            $options[CURLOPT_CAINFO] = $policy->testCaFile;
        }
        if (!curl_setopt_array($curl, $options)) {
            throw new Failure(GateError::Internal);
        }
        $ok = curl_exec($curl);

        return [$ok !== false, curl_errno($curl), curl_getinfo($curl, CURLINFO_RESPONSE_CODE)];
    }
}
