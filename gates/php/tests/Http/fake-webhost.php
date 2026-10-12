<?php

declare(strict_types=1);

// The TLS front of the hardening check test (SEC-49): plays the customer's web server in front of
// the gate under `php -S`. Mode "guarded" passes every request on, so PHP runs the data files and
// they answer 404. Mode "raw" plays a misconfigured host: files in the data folder come back as
// source and the folder as a listing. TEST ONLY certificate, 127.0.0.1 only.
// php fake-webhost.php <cert.pem> <key.pem> <port file> <backend port> <site dir> <guarded|raw>

$args = is_array($_SERVER['argv'] ?? null) ? array_values(array_filter($_SERVER['argv'], is_string(...))) : [];
if (count($args) !== 7) {
    fwrite(STDERR, "usage: fake-webhost.php <cert> <key> <port file> <backend port> <site dir> <guarded|raw>\n");
    exit(2);
}
[, $cert, $key, $portFile, $backend, $site, $mode] = $args;
set_error_handler(static fn(): bool => true);

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
    while (($line = fgets($connection)) !== false && rtrim($line, "\r\n") !== '') {
        // Headers are not needed: the check sends plain GETs.
    }
    $target = explode(' ', trim((string) $requestLine), 3)[1] ?? '/';
    $status = 404;
    $body = '';
    if ($mode === 'raw' && preg_match('#^/(moat-data-[0-9a-f]{32})/([a-z]*\.php)?$#D', $target, $match) === 1) {
        $folder = $site . '/' . $match[1];
        if (($match[2] ?? '') === '') {
            $status = 200;
            $body = '<html><body>' . implode('<br>', array_map(basename(...), glob($folder . '/*') ?: [])) . '</body></html>';
        } elseif (is_file($folder . '/' . $match[2])) {
            $status = 200;
            $body = (string) file_get_contents($folder . '/' . $match[2]);
        }
    } else {
        $answer = file_get_contents('http://127.0.0.1:' . $backend . $target, false, stream_context_create(['http' => ['ignore_errors' => true, 'timeout' => 5]]));
        $body = $answer === false ? '' : $answer;
        $statusLine = isset($http_response_header[0]) && is_string($http_response_header[0]) ? $http_response_header[0] : '';
        $status = preg_match('#^HTTP/\S+ ([0-9]{3})#', $statusLine, $code) === 1 ? (int) $code[1] : 502;
    }
    fwrite($connection, "HTTP/1.1 {$status} X\r\nContent-Type: text/html\r\nContent-Length: " . strlen($body) . "\r\nConnection: close\r\n\r\n" . $body);
    fclose($connection);
}
