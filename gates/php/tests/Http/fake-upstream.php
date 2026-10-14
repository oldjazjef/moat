<?php

declare(strict_types=1);

// The fake HTTPS upstream of the HTTP conformance runner (conformance/http/gate.json): one request
// at a time on 127.0.0.1, TLS with the runner's TEST ONLY certificate. Never a real API.
// php fake-upstream.php <cert.pem> <key.pem> <port file> <log file> <secrets, one per line>

$args = is_array($_SERVER['argv'] ?? null) ? array_values(array_filter($_SERVER['argv'], is_string(...))) : [];
if (count($args) !== 6) {
    fwrite(STDERR, "usage: fake-upstream.php <cert> <key> <port file> <log file> <secret>\n");
    exit(2);
}
[, $cert, $key, $portFile, $logFile, $secretList] = $args;
// Every secret of the case file, one per line; the first is the upstream's.
$secrets = explode("\n", $secretList);
$secret = $secrets[0];
// Failed handshakes and broken connections are expected: ignore their warnings.
set_error_handler(static fn(): bool => true);

$tokens = 0;
$context = stream_context_create(['ssl' => ['local_cert' => $cert, 'local_pk' => $key]]);
$server = stream_socket_server('tls://127.0.0.1:0', $errno, $error, STREAM_SERVER_BIND | STREAM_SERVER_LISTEN, $context);
if ($server === false) {
    fwrite(STDERR, "cannot listen\n");
    exit(1);
}
$name = (string) stream_socket_get_name($server, false);
file_put_contents($portFile, substr($name, (int) strrpos($name, ':') + 1));

for (;;) {
    $connection = stream_socket_accept($server, -1);
    if ($connection === false) {
        continue;
    }
    stream_set_timeout($connection, 5);
    $requestLine = fgets($connection);
    if ($requestLine === false) {
        fclose($connection);
        continue;
    }
    $headers = [];
    while (($line = fgets($connection)) !== false && rtrim($line, "\r\n") !== '') {
        $parts = explode(':', rtrim($line, "\r\n"), 2);
        $headers[strtolower(trim($parts[0]))] = trim($parts[1] ?? '');
    }
    $body = '';
    $length = (int) ($headers['content-length'] ?? '0');
    while (strlen($body) < $length && !feof($connection)) {
        $chunk = fread($connection, max(1, $length - strlen($body)));
        if ($chunk === false || $chunk === '') {
            break;
        }
        $body .= $chunk;
    }
    [$method, $target] = array_pad(explode(' ', trim($requestLine), 3), 2, '');
    [$path, $query] = array_pad(explode('?', $target, 2), 2, '');
    file_put_contents($logFile, $method . ' ' . $path . "\n", FILE_APPEND);

    $status = 200;
    $type = 'application/json';
    $extra = [];
    $hide = static function (string $text) use ($secret, $secrets): string {
        // A Basic credential `user:<secret>` (FR-20) and an access token from /token are shown as
        // placeholders, like the secret itself.
        if (preg_match('/^Basic ([A-Za-z0-9+\/=]+)$/D', $text, $basic) === 1) {
            $decoded = base64_decode($basic[1], true);
            if (is_string($decoded) && str_contains($decoded, $secret)) {
                $text = 'Basic ' . $decoded;
            }
        }
        $text = (string) preg_replace('/TEST-ONLY-access-token-[0-9]+/', '<TOKEN>', $text);

        foreach ($secrets as $one) {
            $text = str_replace([$one, rawurlencode($one)], '<SECRET>', $text);
        }

        return $text;
    };
    if ($path === '/echo') {
        $answer = json_encode(
            ['method' => $method, 'path' => $path, 'query' => $hide($query), 'headers' => array_map($hide, $headers), 'body' => $body],
            JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES,
        );
    } elseif ($path === '/token') {
        // OAuth2 client credentials (FR-20): client_secret_basic with the form-encoded id and secret.
        $wanted = 'Basic ' . base64_encode('moat-client:' . rawurlencode($secret));
        $grant = $method === 'POST' && ($headers['content-type'] ?? '') === 'application/x-www-form-urlencoded'
            && in_array($body, ['grant_type=client_credentials', 'grant_type=client_credentials&scope=read%20write'], true);
        if (hash_equals($wanted, $headers['authorization'] ?? '') && $grant) {
            ++$tokens;
            $answer = '{"access_token":"TEST-ONLY-access-token-' . $tokens . '","token_type":"Bearer","expires_in":3600}';
        } else {
            $status = 401;
            $answer = '{"error":"invalid_client"}';
        }
    } elseif ($path === '/turnstile') {
        // Cloudflare Turnstile's siteverify (FR-16): a form with one of the secrets and the token.
        $form = [];
        foreach (explode('&', $body) as $pair) {
            [$name, $value] = array_pad(explode('=', $pair, 2), 2, '');
            $form[rawurldecode($name)] = rawurldecode($value);
        }
        $pass = $method === 'POST' && in_array($form['secret'] ?? '', $secrets, true) && ($form['response'] ?? '') === 'TEST-ONLY-turnstile-pass';
        $answer = $pass ? '{"success":true}' : '{"success":false,"error-codes":["invalid-input-response"]}';
    } elseif ($path === '/token-fail') {
        $status = 401;
        $answer = '{"error":"invalid_client"}';
    } elseif ($path === '/token-bad') {
        $answer = '{"token_type":"Bearer","expires_in":3600}';
    } elseif ($path === '/usage') {
        $answer = '{"id":"chatcmpl-1","usage":{"prompt_tokens":60,"completion_tokens":40,"total_tokens":100}}';
    } elseif ($path === '/bundles/gate.json') {
        // What the lazy pull fetches (conformance/http/gate-pull.json), as the runner published it.
        $published = json_decode((string) file_get_contents(dirname($logFile) . '/published.json'), true);
        $status = is_array($published) && is_int($published['status'] ?? null) ? $published['status'] : 404;
        $answer = is_array($published) && is_string($published['body'] ?? null) ? $published['body'] : '{}';
        $type = 'application/octet-stream';
        if ($status === 302) {
            $extra[] = 'Location: https://upstream.test/bundles/other.json';
        }
    } elseif ($path === '/no-usage') {
        $answer = '{"id":"chatcmpl-2"}';
    } elseif ($path === '/redirect') {
        $status = 302;
        $extra[] = 'Location: https://upstream.test/echo';
        $answer = '{}';
    } elseif ($path === '/html') {
        $type = 'text/html';
        $answer = '<p>hello</p>';
    } elseif ($path === '/big') {
        $answer = '"' . str_repeat('a', 99_998) . '"';
    } elseif ($path === '/slow') {
        sleep(2);
        $answer = '{}';
    } elseif ($path === '/reflect') {
        $answer = json_encode(['authorization' => $headers['authorization'] ?? ''], JSON_THROW_ON_ERROR);
    } elseif ($path === '/set-cookie') {
        $extra[] = 'Set-Cookie: upstream=1';
        $extra[] = 'X-Upstream: 1';
        $answer = '{"ok":true}';
    } elseif (preg_match('~^/status/([0-9]{3})$~D', $path, $match) === 1) {
        $status = (int) $match[1];
        $answer = $status === 204 ? '' : '{"error":"upstream says no"}';
    } else {
        $status = 404;
        $answer = '{}';
    }
    $head = "HTTP/1.1 {$status} X\r\n" . ($answer === '' ? '' : "Content-Type: {$type}\r\n")
        . 'Content-Length: ' . strlen($answer) . "\r\nConnection: close\r\n";
    foreach ($extra as $header) {
        $head .= $header . "\r\n";
    }
    fwrite($connection, $head . "\r\n" . $answer);
    fclose($connection);
}
