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

    public static function send(UpstreamRequest $request, Policy $policy): UpstreamResponse
    {
        $address = AddressGuard::resolve($request->host, $request->port, $policy);
        $pin = $request->host . ':' . $request->port . ':' . (str_contains($address, ':') ? '[' . $address . ']' : $address);
        $url = 'https://' . $request->host . ($request->port === 443 ? '' : ':' . $request->port) . $request->pathAndQuery;

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
            CURLOPT_CONNECTTIMEOUT_MS => min($request->timeoutMs, 5000),
            CURLOPT_TIMEOUT_MS => $request->timeoutMs,
            CURLOPT_NOSIGNAL => true,
            CURLOPT_CUSTOMREQUEST => $request->method,
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
            CURLOPT_WRITEFUNCTION => static function (\CurlHandle $handle, string $chunk) use ($received, $request): int {
                if (\strlen($received->body) + \strlen($chunk) > $request->maxResponseBytes) {
                    $received->tooLarge = true;

                    return 0;
                }
                $received->body .= $chunk;

                return \strlen($chunk);
            },
        ];
        if ($request->body !== '') {
            $options[CURLOPT_POSTFIELDS] = $request->body;
        }
        if ($policy->testCaFile !== null) {
            $options[CURLOPT_CAINFO] = $policy->testCaFile;
        }
        if (!curl_setopt_array($curl, $options)) {
            throw new Failure(GateError::Internal);
        }
        $ok = curl_exec($curl);
        $errno = curl_errno($curl);
        $status = curl_getinfo($curl, CURLINFO_RESPONSE_CODE);

        if ($received->tooLarge) {
            throw new Failure(GateError::UpstreamTooLarge);
        }
        if ($ok === false || $errno !== 0) {
            throw new Failure($errno === CURLE_OPERATION_TIMEDOUT ? GateError::UpstreamTimeout : GateError::UpstreamUnreachable);
        }
        if (!\is_int($status) || $status < 200 || $status > 599) {
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
}
