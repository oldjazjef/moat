<?php

declare(strict_types=1);

namespace Moat\Gate\Tests\Http;

use Moat\Gate\Tests\Conformance\Vectors;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * One file of conformance/http/ against the built gate file under a real web server and a fake
 * HTTPS upstream (SEC-41 to SEC-46, FR-18). The planted secret must never reach a client answer
 * or the gate's log. Each file has its own subclass and its own gate.
 */
abstract class HttpConformanceCase extends TestCase
{
    private static ?GateFixture $gate = null;

    /** The file under conformance/, e.g. `http/gate.json`. */
    abstract protected static function casesFile(): string;

    public static function setUpBeforeClass(): void
    {
        $dir = sys_get_temp_dir() . '/moat-http-' . bin2hex(random_bytes(6));
        mkdir($dir, 0o700);
        self::$gate = new GateFixture($dir, (string) file_get_contents(\dirname(__DIR__, 4) . '/conformance/' . static::casesFile()));
    }

    public static function tearDownAfterClass(): void
    {
        self::$gate?->stop();
        self::$gate = null;
    }

    /** @return iterable<string, array{array<string, mixed>}> */
    public static function cases(): iterable
    {
        $file = \dirname(__DIR__, 4) . '/conformance/' . static::casesFile();
        $doc = json_decode((string) file_get_contents($file), true, 512, JSON_THROW_ON_ERROR);
        foreach (Vectors::list(Vectors::map($doc)['cases'] ?? null) as $case) {
            $case = Vectors::map($case);
            yield Vectors::string($case['name']) => [$case];
        }
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('cases')]
    public function testCase(array $case): void
    {
        $gate = self::$gate ?? throw new \LogicException('no gate');
        $request = Vectors::map($case['request']);
        $expect = Vectors::map($case['expect']);
        if (\array_key_exists('killFile', $case)) {
            $gate->setKillFile($case['killFile'] === null ? null : Vectors::map($case['killFile']));
        }
        if (isset($case['setup'])) {
            $gate->setup(Vectors::string($case['setup']));
        }
        if (isset($case['publish'])) {
            $gate->publish(Vectors::map($case['publish']));
        }
        if (($case['pullDue'] ?? false) === true) {
            $gate->setPullDue();
        }
        $before = $gate->upstreamCalls();
        $pullsBefore = $gate->pulls();

        $request = self::withSetupToken($request, $gate->setupToken);
        [$status, $headers, $body] = self::send($gate->baseUrl, $request);

        self::assertSame(Vectors::int($expect['status']), $status, $body);
        if (isset($expect['error'])) {
            self::assertSame(['error' => $expect['error']], json_decode($body, true));
        }
        if (isset($expect['json'])) {
            self::assertSubset(Vectors::map($expect['json']), json_decode($body, true), 'json');
        }
        foreach (Vectors::map($expect['headers'] ?? []) as $name => $value) {
            if ($value === '<any>') {
                self::assertArrayHasKey($name, $headers, "header {$name}");
            } else {
                self::assertSame($value, $headers[$name] ?? null, "header {$name}");
            }
        }
        self::assertSame(Vectors::int($expect['upstreamCalls']), $gate->upstreamCalls() - $before, 'upstream calls');
        if (isset($expect['pulls'])) {
            self::assertSame(Vectors::int($expect['pulls']), $gate->pulls() - $pullsBefore, 'pulls');
        }
        foreach (explode("\n", $gate->secret) as $secret) {
            self::assertStringNotContainsString($secret, $body . implode("\n", $headers));
        }
        self::assertLog($gate->requestLog(), $expect);
    }

    /**
     * conformance/http/gate-log.json: `log` = the newest line (`t`, `ms`, `client` by shape),
     * `logExcludes` = texts the log never holds, `logBytesAtMost` = both files together.
     *
     * @param array<string, mixed> $expect
     */
    private static function assertLog(string $log, array $expect): void
    {
        if (\array_key_exists('log', $expect)) {
            $lines = explode("\n", rtrim($log, "\n"));
            $last = json_decode(end($lines), true, 8, JSON_THROW_ON_ERROR);
            self::assertIsArray($last, 'log line');
            self::assertSame(['client', 'error', 'method', 'ms', 'route', 'status', 't'], self::sortedKeys($last), 'log keys');
            foreach (Vectors::map($expect['log']) as $key => $value) {
                self::assertSame($value, $last[$key], "log.{$key}");
            }
            self::assertIsInt($last['t']);
            self::assertTrue(abs(time() - $last['t']) < 120, 'log.t');
            self::assertIsInt($last['ms']);
            self::assertTrue($last['ms'] >= 0, 'log.ms');
            self::assertIsString($last['client']);
            self::assertMatchesRegularExpression('/^[0-9a-f]{16}$/D', $last['client']);
        }
        foreach (Vectors::list($expect['logExcludes'] ?? []) as $text) {
            self::assertStringNotContainsString(Vectors::string($text), $log, 'log');
        }
        if (isset($expect['logBytesAtMost'])) {
            self::assertTrue(\strlen($log) <= Vectors::int($expect['logBytesAtMost']), 'log size');
        }
    }

    /**
     * @param array<mixed> $map
     *
     * @return list<int|string>
     */
    private static function sortedKeys(array $map): array
    {
        $keys = array_keys($map);
        sort($keys);

        return $keys;
    }

    /**
     * `{setupToken}` in the path or a header value: the token `setup` printed.
     *
     * @param array<string, mixed> $request
     *
     * @return array<string, mixed>
     */
    private static function withSetupToken(array $request, string $token): array
    {
        $request['path'] = str_replace('{setupToken}', $token, Vectors::string($request['path']));
        $headers = [];
        foreach (Vectors::map($request['headers']) as $name => $value) {
            $headers[$name] = str_replace('{setupToken}', $token, Vectors::string($value));
        }
        $request['headers'] = $headers;

        return $request;
    }

    /** Runs after every case (PHPUnit keeps declaration order). */
    public function testSecretNeverInTheGateLog(): void
    {
        $gate = self::$gate ?? throw new \LogicException('no gate');
        foreach (explode("\n", $gate->secret) as $secret) {
            self::assertStringNotContainsString($secret, $gate->gateLogText());
        }
    }

    /**
     * @param array<string, mixed> $request
     *
     * @return array{int, array<string, string>, string}
     */
    private static function send(string $baseUrl, array $request): array
    {
        $headers = [];
        $sent = [];
        foreach (Vectors::map($request['headers']) as $name => $value) {
            $sent[] = $name . ': ' . Vectors::string($value);
        }
        if (!isset(Vectors::map($request['headers'])['Content-Type'])) {
            $sent[] = 'Content-Type:';
        }
        $method = Vectors::string($request['method']);
        if ($method === '') {
            throw new \RuntimeException('a case without a method');
        }
        $curl = curl_init($baseUrl . Vectors::string($request['path']));
        if ($curl === false) {
            throw new \RuntimeException('curl_init failed');
        }
        $options = [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HTTPHEADER => [...$sent, 'Expect:'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_PATH_AS_IS => true,
            CURLOPT_PROXY => '',
            CURLOPT_TIMEOUT => 20,
            CURLOPT_HEADERFUNCTION => static function (\CurlHandle $handle, string $line) use (&$headers): int {
                $parts = explode(':', $line, 2);
                if (isset($parts[1])) {
                    $headers[strtolower(trim($parts[0]))] = trim($parts[1]);
                }

                return \strlen($line);
            },
        ];
        $body = Vectors::string($request['body']);
        if ($body !== '') {
            $options[CURLOPT_POSTFIELDS] = $body;
        }
        curl_setopt_array($curl, $options);
        $answer = curl_exec($curl);
        if (!\is_string($answer)) {
            throw new \RuntimeException('request failed: ' . curl_error($curl));
        }

        return [Vectors::int(curl_getinfo($curl, CURLINFO_RESPONSE_CODE)), $headers, $answer];
    }

    /**
     * `null` in the expectation means "absent"; objects are compared as subsets.
     *
     * @param array<mixed> $expected
     */
    private static function assertSubset(array $expected, mixed $actual, string $where): void
    {
        if (!\is_array($actual)) {
            self::fail("{$where} is not an object");
        }
        foreach ($expected as $key => $value) {
            if ($value === null) {
                self::assertArrayNotHasKey($key, $actual, "{$where}.{$key}");
            } elseif (\is_array($value) && !array_is_list($value)) {
                self::assertSubset($value, $actual[$key] ?? null, "{$where}.{$key}");
            } else {
                self::assertSame($value, $actual[$key] ?? null, "{$where}.{$key}");
            }
        }
    }
}
