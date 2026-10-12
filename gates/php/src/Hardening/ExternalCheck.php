<?php

declare(strict_types=1);

namespace Moat\Gate\Hardening;

use Moat\Gate\Http\GateError;
use Moat\Gate\Json\JsonObject;
use Moat\Gate\Json\StrictJson;
use Moat\Gate\Policy\Policy;
use Moat\Gate\Rejection;
use Moat\Gate\Storage\DataDir;
use Moat\Gate\Upstream\UpstreamClient;

/**
 * The check from outside (SEC-49): fetches the gate's data folder and data files over the
 * public URL, through the one cURL client, the way anyone on the internet could. A file counts
 * as reachable when its source comes back (the guard marker is in the body), the folder when a
 * listing names a data file. First the URL must reach this very gate (it records the nonce of
 * the check), otherwise a wrong URL would "prove" that nothing is reachable. A redirect counts as
 * a failed check.
 */
final class ExternalCheck
{
    /**
     * @return array{string, int, string} host, port and path of an `https://host[:port]/…/file.php` URL
     *
     * @throws \InvalidArgumentException for anything else
     */
    public static function parseUrl(string $url): array
    {
        $parts = parse_url($url);
        $host = \is_array($parts) && \is_string($parts['host'] ?? null) ? strtolower($parts['host']) : '';
        $path = \is_array($parts) && \is_string($parts['path'] ?? null) ? $parts['path'] : '';
        if (!\is_array($parts) || ($parts['scheme'] ?? '') !== 'https' || isset($parts['user']) || isset($parts['pass'])
            || isset($parts['query']) || isset($parts['fragment']) || preg_match('/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/D', $host) !== 1
            || preg_match('/^\/([A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+\.php$/D', $path) !== 1) {
            throw new \InvalidArgumentException('--url must be the public https:// URL of this gate file, like https://example.ch/api/moat-gate.php');
        }

        return [$host, \is_int($parts['port'] ?? null) ? $parts['port'] : 443, $path];
    }

    public static function run(string $url, DataDir $data, ?Policy $policy): External
    {
        [$host, $port, $path] = self::parseUrl($url);
        $nonce = bin2hex(random_bytes(16));
        $data->write(WebFacts::CHECK_REQUEST, $nonce . "\n");
        try {
            $gate = UpstreamClient::probe($host, $port, $path . '/moat-check', $policy);
        } finally {
            $data->remove(WebFacts::CHECK_REQUEST);
        }
        if ($gate === null) {
            return External::Failed;
        }
        // Another gate (say a staging copy on the same host) answers alike, but only this one has
        // read the nonce and recorded it.
        if (!self::answersLikeGate($gate[1]) || WebFacts::read($data)?->check !== $nonce) {
            return External::NotGate;
        }
        $folder = substr($path, 0, (int) strrpos($path, '/') + 1) . basename($data->path) . '/';
        $names = $data->fileNames();
        $failed = false;

        $listing = UpstreamClient::probe($host, $port, $folder, $policy);
        if (self::unanswered($listing)) {
            $failed = true;
        } elseif ($listing !== null) {
            foreach ($names as $name) {
                if (str_contains($listing[1], $name)) {
                    return External::Reachable;
                }
            }
        }
        foreach ([...$names, 'index.php'] as $name) {
            $file = UpstreamClient::probe($host, $port, $folder . $name, $policy);
            if (self::unanswered($file)) {
                $failed = true;
            } elseif ($file !== null) {
                $reachable = str_contains($file[1], '__halt_compiler');
                // A reachable file holds key bytes: wipe the copy.
                sodium_memzero($file[1]);
                if ($reachable) {
                    return External::Reachable;
                }
            }
        }

        return $failed ? External::Failed : External::Blocked;
    }

    /**
     * No answer, or a redirect: a redirect is not followed, so what lies behind it is unknown.
     *
     * @param ?array{int, string} $answer
     */
    private static function unanswered(?array $answer): bool
    {
        return $answer === null || ($answer[0] >= 300 && $answer[0] < 400);
    }

    /** The gate's own error answer: `{"error":"<code>"}` with a code it knows. */
    private static function answersLikeGate(string $body): bool
    {
        try {
            $value = StrictJson::decode(rtrim($body, "\n"));
        } catch (Rejection | \RuntimeException) {
            return false;
        }
        if (!$value instanceof JsonObject || !$value->hasExactKeys('error')) {
            return false;
        }
        $code = $value->get('error');

        return \is_string($code) && GateError::tryFrom($code) !== null;
    }
}
