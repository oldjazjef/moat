<?php

declare(strict_types=1);

namespace Moat\Gate\Tests\Http;

use Moat\Gate\Build\Builder;
use Moat\Gate\Crypto\KeyAlgorithm;
use Moat\Gate\Crypto\KeyId;
use Moat\Gate\Encoding\Base64Url;
use Moat\Gate\Storage\DataDir;

/**
 * A real gate for the HTTP conformance cases: the built single file in a temp web root under
 * `php -S`, installed and fed through its own CLI, plus the fake HTTPS upstream with a TEST ONLY
 * certificate. Bundles are sealed and signed here, the way docs/CRYPTO.md §4 and §5 describe.
 */
final class GateFixture
{
    public const GATE_FILE = 'moat-gate.php';

    /** @var list<resource> */
    private array $processes = [];

    public readonly string $baseUrl;
    public readonly string $upstreamLog;
    public readonly string $gateLog;
    public readonly string $secret;
    public readonly string $site;
    public readonly int $port;
    public readonly string $certFile;
    public readonly string $keyFile;
    public readonly string $policy;
    /**
     * For bundles the cases publish for the pull (conformance/http/gate-pull.json).
     *
     * @var non-empty-string
     */
    private string $signer;
    private string $gateId;
    private string $boxKey;
    private \stdClass $config;

    /** @param string $casesFile the raw text of conformance/http/gate.json */
    public function __construct(private readonly string $dir, string $casesFile)
    {
        $this->upstreamLog = $dir . '/upstream.log';
        $this->gateLog = $dir . '/gate.log';
        [$cert, $key] = self::certificate($dir);
        $this->certFile = $cert;
        $this->keyFile = $key;
        touch($this->upstreamLog);

        $doc = self::decode($casesFile);
        $secrets = $doc->secrets ?? null;
        if (!$secrets instanceof \stdClass) {
            throw new \RuntimeException('gate.json has no secrets');
        }
        $values = [];
        foreach (get_object_vars($secrets) as $name => $value) {
            if (!\is_string($value)) {
                throw new \RuntimeException('gate.json: secret values are strings');
            }
            $values[(string) $name] = $value;
        }
        $this->secret = implode("\n", $values);

        $portFile = $dir . '/upstream.port';
        $this->spawn([PHP_BINARY, __DIR__ . '/fake-upstream.php', $cert, $key, $portFile, $this->upstreamLog, $values['api-token'] ?? ''], $dir . '/upstream.err');
        $upstreamPort = self::waitForFile($portFile);
        $doc = self::decode(str_replace(['{port}', '{caFile}'], [$upstreamPort, $cert], $casesFile));

        $site = $this->site = $dir . '/site';
        mkdir($site);
        file_put_contents($site . '/' . self::GATE_FILE, Builder::build(\dirname(__DIR__, 2) . '/src', '0.0.0-test', 'test'));
        $signer = sodium_crypto_sign_keypair();
        $install = $this->cli($site, ['install', '--signer=' . Base64Url::encode(sodium_crypto_sign_publickey($signer))]);
        if (preg_match('/--gate-id=(\S+) --box-key=(\S+)/', $install, $match) !== 1) {
            throw new \RuntimeException('install printed no gate id');
        }
        [, $gateId, $boxKey] = $match;
        $this->signer = $signer;
        $this->gateId = $gateId;
        $this->boxKey = $boxKey;
        $config = $doc->config ?? null;
        $this->config = $config instanceof \stdClass ? $config : new \stdClass();
        $this->policy = self::encode($doc->policy ?? null);
        file_put_contents($dir . '/policy.json', $this->policy);
        $this->cli($site, ['policy', $dir . '/policy.json']);

        $sealed = [];
        foreach ($values as $name => $value) {
            $sealed[$name] = self::seal($value, Base64Url::decode($boxKey), $gateId, $name);
        }
        file_put_contents($dir . '/bundle.json', self::bundle($doc->config ?? null, $sealed, $gateId, $signer));
        $this->cli($site, ['accept', $dir . '/bundle.json']);

        $port = $this->port = self::freePort();
        $this->spawn([PHP_BINARY, '-S', '127.0.0.1:' . $port, '-t', $site], $this->gateLog);
        self::waitForPort($port);
        $this->baseUrl = 'http://127.0.0.1:' . $port . '/' . self::GATE_FILE;
    }

    public function stop(): void
    {
        foreach ($this->processes as $process) {
            proc_terminate($process);
            proc_close($process);
        }
        $this->processes = [];
        self::remove($this->dir);
    }

    /**
     * Sets the kill switch file (conformance/http/gate-kill-switch.json): null removes it,
     * `content` writes a data file with that text, `raw` exactly these bytes without the marker.
     *
     * @param array<string, mixed>|null $file
     */
    public function setKillFile(?array $file): void
    {
        $data = DataDir::locate($this->site) ?? throw new \RuntimeException('no data folder');
        $path = $data->path . '/kill.php';
        if ($file === null) {
            $data->remove('kill');
        } elseif (isset($file['content']) && \is_string($file['content'])) {
            $data->write('kill', $file['content']);
        } elseif (isset($file['raw']) && \is_string($file['raw'])) {
            file_put_contents($path, $file['raw']);
        } else {
            throw new \RuntimeException('killFile: content, raw or null');
        }
    }

    /** Upstream calls other than fetching the published bundle file. */
    public function upstreamCalls(): int
    {
        $log = file_get_contents($this->upstreamLog);

        return $log === false ? 0 : substr_count($log, "\n") - $this->pulls();
    }

    /** Fetches of the published bundle file (the lazy pull, DT-11). */
    public function pulls(): int
    {
        $log = file_get_contents($this->upstreamLog);

        return $log === false ? 0 : substr_count($log, 'GET ' . self::PUBLISHED_PATH . "\n");
    }

    public const PUBLISHED_PATH = '/bundles/gate.json';

    /**
     * What the fake upstream serves at PUBLISHED_PATH from now on (conformance/http/gate-pull.json):
     * a bundle signed by the pinned signer (`version`, `routes` added to the config, `enabled`,
     * `tamper`, `otherGate`), only a `status`, `size` bytes, or `raw` text.
     *
     * @param array<string, mixed> $publish
     */
    public function publish(array $publish): void
    {
        $status = 200;
        if (isset($publish['status']) && \is_int($publish['status'])) {
            $status = $publish['status'];
            $body = '{}';
        } elseif (isset($publish['size']) && \is_int($publish['size'])) {
            $body = str_repeat('x', $publish['size']);
        } elseif (isset($publish['raw']) && \is_string($publish['raw'])) {
            $body = $publish['raw'];
        } elseif (isset($publish['version']) && \is_int($publish['version'])) {
            $config = clone $this->config;
            $routes = $config->routes instanceof \stdClass ? clone $config->routes : new \stdClass();
            foreach (\is_array($publish['routes'] ?? null) ? $publish['routes'] : [] as $name => $route) {
                $routes->{$name} = json_decode(self::encode($route), false, 512, JSON_THROW_ON_ERROR);
            }
            $config->routes = $routes;
            if (isset($publish['enabled']) && \is_bool($publish['enabled'])) {
                $config->enabled = $publish['enabled'];
            }
            $gateId = $this->gateId;
            $boxKey = Base64Url::decode($this->boxKey);
            if (($publish['otherGate'] ?? false) === true) {
                $gateId = Base64Url::encode(random_bytes(16));
                $boxKey = sodium_crypto_box_publickey(sodium_crypto_box_keypair());
            }
            $sealed = [];
            $sealed['api-token'] = self::seal(explode("\n", $this->secret)[0], $boxKey, $gateId, 'api-token');
            $body = self::bundle($config, $sealed, $gateId, $this->signer, $publish['version']);
            if (($publish['tamper'] ?? false) === true) {
                // One byte of the signed payload changed: the signature no longer fits.
                $envelope = json_decode($body, true, 512, JSON_THROW_ON_ERROR);
                if (!\is_array($envelope) || !\is_string($envelope['payload'] ?? null)) {
                    throw new \RuntimeException('publish: not an envelope');
                }
                $payload = Base64Url::decode($envelope['payload']);
                $envelope['payload'] = Base64Url::encode(str_replace('"version":' . $publish['version'], '"version":' . ($publish['version'] + 10), $payload));
                $body = self::encode($envelope);
            }
        } else {
            throw new \RuntimeException('publish: version, status, size or raw');
        }
        file_put_contents(\dirname($this->upstreamLog) . '/published.json', self::encode(['status' => $status, 'body' => $body]));
    }

    /** Makes the pull interval over: the gate looks again on the next request. */
    public function setPullDue(): void
    {
        (DataDir::locate($this->site) ?? throw new \RuntimeException('no data folder'))->remove('pull');
    }

    public function gateLogText(): string
    {
        $log = file_get_contents($this->gateLog);

        return $log === false ? '' : $log;
    }

    /**
     * The gate's CLI with its exit status and output (stdout, then stderr).
     *
     * @param list<string> $args
     *
     * @return array{int, string}
     */
    public function run(array $args): array
    {
        $outFile = $this->dir . '/cli.out';
        $process = proc_open([PHP_BINARY, $this->site . '/' . self::GATE_FILE, ...$args], [1 => ['file', $outFile, 'w'], 2 => ['file', $outFile, 'a']], $pipes);
        if ($process === false) {
            throw new \RuntimeException('cannot start the gate CLI');
        }
        $status = proc_close($process);

        return [$status, (string) file_get_contents($outFile)];
    }

    /** @param list<string> $args */
    private function cli(string $site, array $args): string
    {
        $outFile = $this->dir . '/cli.out';
        $errFile = $this->dir . '/cli.err';
        $process = proc_open([PHP_BINARY, $site . '/' . self::GATE_FILE, ...$args], [1 => ['file', $outFile, 'w'], 2 => ['file', $errFile, 'w']], $pipes);
        if ($process === false) {
            throw new \RuntimeException('cannot start the gate CLI');
        }
        $status = proc_close($process);
        $out = (string) file_get_contents($outFile);
        $err = (string) file_get_contents($errFile);
        if ($status !== 0) {
            throw new \RuntimeException('gate CLI ' . $args[0] . ' failed: ' . $err);
        }

        return $out;
    }

    /** @param list<string> $command */
    public function spawn(array $command, string $log): void
    {
        $process = proc_open($command, [0 => ['pipe', 'r'], 1 => ['file', $log, 'a'], 2 => ['file', $log, 'a']], $pipes);
        if ($process === false) {
            throw new \RuntimeException('cannot start ' . $command[1]);
        }
        $this->processes[] = $process;
    }

    /**
     * docs/CRYPTO.md §5 — the client side, for the test only.
     *
     * @return array<string, int|string>
     */
    public static function seal(string $plaintext, string $gatePublicKey, string $gateId, string $name): array
    {
        $pair = sodium_crypto_box_keypair();
        $epk = sodium_crypto_box_publickey($pair);
        $shared = sodium_crypto_scalarmult(sodium_crypto_box_secretkey($pair), $gatePublicKey);
        $key = sodium_crypto_generichash('moat:secret:v1' . $epk . $gatePublicKey, $shared, 32);
        $nonce = random_bytes(SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_NPUBBYTES);
        $ct = sodium_crypto_aead_xchacha20poly1305_ietf_encrypt($plaintext, 'moat:secret:v1|' . $gateId . '|' . $name . '|1', $nonce, $key);

        return [
            'v' => 1,
            'alg' => 'x25519-blake2b-xchacha20poly1305',
            'secretVersion' => 1,
            'epk' => Base64Url::encode($epk),
            'nonce' => Base64Url::encode($nonce),
            'ct' => Base64Url::encode($ct),
        ];
    }

    /**
     * @param array<string, array<string, int|string>> $sealed
     * @param non-empty-string                         $signer an Ed25519 key pair
     */
    public static function bundle(mixed $config, array $sealed, string $gateId, string $signer, int $version = 1, ?int $issuedAt = null): string
    {
        $payload = self::encode([
            'type' => 'moat.bundle',
            'v' => 1,
            'gateId' => $gateId,
            'version' => $version,
            'issuedAt' => $issuedAt ?? time(),
            'expiresAt' => null,
            'config' => $config,
            'secrets' => (object) $sealed,
        ]);
        $signature = sodium_crypto_sign_detached("moat:bundle:v1\n" . $payload, sodium_crypto_sign_secretkey($signer));
        $publicKey = sodium_crypto_sign_publickey($signer);

        return self::encode([
            'moat' => 'bundle',
            'v' => 1,
            'payload' => Base64Url::encode($payload),
            'sigs' => [['kid' => KeyId::of(KeyAlgorithm::Ed25519, $publicKey), 'alg' => 'ed25519', 'sig' => Base64Url::encode($signature)]],
        ]);
    }

    private static function encode(mixed $value): string
    {
        return json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    }

    private static function decode(string $text): \stdClass
    {
        $value = json_decode($text, false, 512, JSON_THROW_ON_ERROR);
        if (!$value instanceof \stdClass) {
            throw new \RuntimeException('gate.json is not an object');
        }

        return $value;
    }

    /**
     * A TEST ONLY self-signed certificate for upstream.test and localhost.
     *
     * @return array{string, string}
     */
    private static function certificate(string $dir): array
    {
        $config = $dir . '/openssl.cnf';
        file_put_contents($config, "[req]\ndefault_bits = 2048\ndistinguished_name = dn\n[dn]\n[ext]\n"
            . "subjectAltName = DNS:upstream.test, DNS:localhost\n"
            . "basicConstraints = critical, CA:TRUE\n"
            . "keyUsage = critical, digitalSignature, keyCertSign\n");
        $options = ['config' => $config, 'digest_alg' => 'sha256', 'private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1', 'x509_extensions' => 'ext'];
        $key = openssl_pkey_new($options);
        if ($key === false) {
            throw new \RuntimeException('cannot create a test key');
        }
        // openssl_csr_new takes the key by reference; keep $key's type for the calls below.
        $csrKey = $key;
        $csr = openssl_csr_new(['commonName' => 'upstream.test (TEST ONLY)'], $csrKey, $options);
        if (!$csr instanceof \OpenSSLCertificateSigningRequest) {
            throw new \RuntimeException('cannot create a test CSR');
        }
        $certificate = openssl_csr_sign($csr, null, $key, 2, $options, random_int(1, PHP_INT_MAX));
        if ($certificate === false || !openssl_x509_export($certificate, $certPem) || !openssl_pkey_export($key, $keyPem, null, $options)) {
            throw new \RuntimeException('cannot create a test certificate');
        }
        file_put_contents($dir . '/upstream-cert.txt', $certPem);
        file_put_contents($dir . '/upstream-key.txt', $keyPem);

        return [$dir . '/upstream-cert.txt', $dir . '/upstream-key.txt'];
    }

    public static function waitForFile(string $file): string
    {
        for ($i = 0; $i < 100; $i++) {
            $text = is_file($file) ? file_get_contents($file) : false;
            if (\is_string($text) && preg_match('/^[0-9]+$/D', $text) === 1) {
                return $text;
            }
            usleep(50_000);
        }

        throw new \RuntimeException('the fake upstream did not start');
    }

    private static function freePort(): int
    {
        $server = stream_socket_server('tcp://127.0.0.1:0');
        if ($server === false) {
            throw new \RuntimeException('no free port');
        }
        $name = (string) stream_socket_get_name($server, false);
        fclose($server);

        return (int) substr($name, (int) strrpos($name, ':') + 1);
    }

    private static function waitForPort(int $port): void
    {
        // "Connection refused" until the server listens is expected, not a test warning.
        set_error_handler(static fn(): bool => true);
        try {
            for ($i = 0; $i < 100; $i++) {
                $client = stream_socket_client('tcp://127.0.0.1:' . $port, $errno, $error, 0.1);
                if ($client !== false) {
                    fclose($client);

                    return;
                }
                usleep(50_000);
            }
        } finally {
            restore_error_handler();
        }

        throw new \RuntimeException('the gate did not start');
    }

    public static function remove(string $path): void
    {
        if (is_dir($path) && !is_link($path)) {
            $entries = scandir($path);
            foreach ($entries === false ? [] : $entries as $entry) {
                if ($entry !== '.' && $entry !== '..') {
                    self::remove($path . '/' . $entry);
                }
            }
            rmdir($path);
        } elseif (file_exists($path) || is_link($path)) {
            unlink($path);
        }
    }
}
