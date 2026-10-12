<?php

declare(strict_types=1);

// The fake HTTPS upstream of the HTTP conformance runner (conformance/http/gate.json): one request
// at a time on 127.0.0.1, TLS with the runner's TEST ONLY certificate. Never a real API.
// php fake-upstream.php <cert.pem> <key.pem> <port file> <log file> <secret>

if ($argc !== 6) {
    fwrite(STDERR, "usage: fake-upstream.php <cert> <key> <port file> <log file> <secret>\n");
    exit(2);
}
[, $cert, $key, $portFile, $logFile, $secret] = $argv;
// Failed handshakes and broken connections are expected: ignore their warnings.
set_error_handler(static fn(): bool => true);

$context = stream_context_create(['ssl' => ['local_cert' => $cert, 'local_pk' => $key]]);
$server = stream_socket_server('tls://127.0.0.1:0', $errno, $error, STREAM_SERVER_BIND | STREAM_SERVER_LISTEN, $context);
if ($server === false) {
    fwrite(STDERR, "cannot listen\n");
    exit(1);
}
$name = (string) stream_socket_get_name($server, false);
file_put_contents($portFile, substr($name, (int) strrpos($name, ':') + 1));

while (true) {
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
        $chunk = fread($connection, $length - strlen($body));
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
    $hide = static fn(string $text): string => str_replace([$secret, rawurlencode($secret)], '<SECRET>', $text);
    if ($path === '/echo') {
        $answer = json_encode(
            ['method' => $method, 'path' => $path, 'query' => $hide($query), 'headers' => array_map($hide, $headers), 'body' => $body],
            JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES,
        );
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
