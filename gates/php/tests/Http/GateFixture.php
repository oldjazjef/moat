<?php

declare(strict_types=1);

namespace Moat\Gate\Tests\Http;

use Moat\Gate\Build\Builder;
use Moat\Gate\Crypto\KeyAlgorithm;
use Moat\Gate\Crypto\KeyId;
use Moat\Gate\Encoding\Base64Url;

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

    /** @param string $casesFile the raw text of conformance/http/gate.json */
    public function __construct(private readonly string $dir, string $casesFile)
    {
        $this->upstreamLog = $dir . '/upstream.log';
        $this->gateLog = $dir . '/gate.log';
        [$cert, $key] = self::certificate($dir);
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

        $site = $dir . '/site';
        mkdir($site);
        file_put_contents($site . '/' . self::GATE_FILE, Builder::build(\dirname(__DIR__, 2) . '/src', '0.0.0-test', 'test'));
        $signer = sodium_crypto_sign_keypair();
        $install = $this->cli($site, ['install', '--signer=' . Base64Url::encode(sodium_crypto_sign_publickey($signer))]);
        if (preg_match('/--gate-id=(\S+) --box-key=(\S+)/', $install, $match) !== 1) {
            throw new \RuntimeException('install printed no gate id');
        }
        [, $gateId, $boxKey] = $match;
        file_put_contents($dir . '/policy.json', self::encode($doc->policy ?? null));
        $this->cli($site, ['policy', $dir . '/policy.json']);

        $sealed = [];
        foreach ($values as $name => $value) {
            $sealed[$name] = self::seal($value, Base64Url::decode($boxKey), $gateId, $name);
        }
        file_put_contents($dir . '/bundle.json', self::bundle($doc->config ?? null, $sealed, $gateId, $signer));
        $this->cli($site, ['accept', $dir . '/bundle.json']);

        $port = self::freePort();
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

    public function upstreamCalls(): int
    {
        $log = file_get_contents($this->upstreamLog);

        return $log === false ? 0 : substr_count($log, "\n");
    }

    public function gateLogText(): string
    {
        $log = file_get_contents($this->gateLog);

        return $log === false ? '' : $log;
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
    private function spawn(array $command, string $log): void
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
    public static function bundle(mixed $config, array $sealed, string $gateId, string $signer, int $version = 1): string
    {
        $payload = self::encode([
            'type' => 'moat.bundle',
            'v' => 1,
            'gateId' => $gateId,
            'version' => $version,
            'issuedAt' => time(),
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

    private static function waitForFile(string $file): string
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

    private static function remove(string $path): void
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
