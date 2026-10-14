<?php

declare(strict_types=1);

namespace Moat\Gate\Tests\Conformance;

use Moat\Gate\Config\BodySchema;
use Moat\Gate\Config\ConfigValidator;
use Moat\Gate\Config\Limit;
use Moat\Gate\Config\Method;
use Moat\Gate\Config\Quota;
use Moat\Gate\Config\QuotaPeriod;
use Moat\Gate\Config\Route;
use Moat\Gate\Http\BodyValidator;
use Moat\Gate\Http\ContentType;
use Moat\Gate\Http\Cors;
use Moat\Gate\Http\PathNormaliser;
use Moat\Gate\Policy\PolicyCheck;
use Moat\Gate\Rejection;
use Moat\Gate\Runtime\ClientKey;
use Moat\Gate\Runtime\RateLimiter;
use Moat\Gate\Storage\DataDir;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * The PHP gate against conformance/vectors/http/ and conformance/vectors/config/ — path
 * normalisation (SEC-42), content types (FR-18), the compiled config (step 9, SEC-20) and the
 * local policy (SEC-10, SEC-11). The same files libs/core passes.
 */
final class FormatVectorsTest extends TestCase
{
    /** @return iterable<string, array{array<string, mixed>}> */
    public static function path(): iterable
    {
        return Vectors::cases('http/path.json');
    }

    /** @return iterable<string, array{array<string, mixed>}> */
    public static function body(): iterable
    {
        return Vectors::cases('http/body.json');
    }

    /** @return iterable<string, array{array<string, mixed>}> */
    public static function contentType(): iterable
    {
        return Vectors::cases('http/content-type.json');
    }

    /** @return iterable<string, array{array<string, mixed>}> */
    public static function origin(): iterable
    {
        return Vectors::cases('http/cors.json', 'origin');
    }

    /** @return iterable<string, array{array<string, mixed>}> */
    public static function preflight(): iterable
    {
        return Vectors::cases('http/cors.json', 'preflight');
    }

    /** @return iterable<string, array{array<string, mixed>}> */
    public static function limitSequence(): iterable
    {
        return Vectors::cases('http/rate-limit.json', 'sequences');
    }

    /** @return iterable<string, array{array<string, mixed>}> */
    public static function client(): iterable
    {
        return Vectors::cases('http/rate-limit.json', 'clients');
    }

    /** @return iterable<string, array{array<string, mixed>}> */
    public static function config(): iterable
    {
        return Vectors::cases('config/config.json');
    }

    /** @return iterable<string, array{array<string, mixed>}> */
    public static function policy(): iterable
    {
        return Vectors::cases('config/policy.json');
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('path')]
    public function testPath(array $case): void
    {
        $input = Vectors::string($case['input']);
        $result = self::outcome(static fn(): array => ['path' => PathNormaliser::normalise($input)]);
        self::assertSame(Vectors::map($case['expect']), $result);
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('contentType')]
    public function testContentType(array $case): void
    {
        $allowed = array_map(Vectors::string(...), array_values(Vectors::list($case['allowed'])));
        $ok = ContentType::isAllowed(Vectors::string($case['header']), $allowed);
        self::assertSame(Vectors::map($case['expect']), ['ok' => $ok]);
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('origin')]
    public function testOrigin(array $case): void
    {
        $route = self::route(Vectors::map($case['route']));
        $origin = $case['origin'] === null ? null : Vectors::string($case['origin']);
        $fetchSite = $case['fetchSite'] === null ? null : Vectors::string($case['fetchSite']);
        $result = self::outcome(static fn(): array => ['allowOrigin' => Cors::check($route, $origin, $fetchSite)]);
        self::assertSame(Vectors::map($case['expect']), $result);
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('preflight')]
    public function testPreflight(array $case): void
    {
        $routes = array_map(static fn(mixed $route): Route => self::route(Vectors::map($route)), array_values(Vectors::list($case['routes'])));
        $headers = $case['requestHeaders'] === null ? null : Vectors::string($case['requestHeaders']);
        $result = self::outcome(static function () use ($routes, $case, $headers): array {
            $answer = Cors::preflight($routes, Vectors::string($case['origin']), Vectors::string($case['requestMethod']), $headers);

            return [
                'allowOrigin' => $answer['Access-Control-Allow-Origin'],
                'allowMethods' => explode(', ', $answer['Access-Control-Allow-Methods']),
                'allowHeaders' => [$answer['Access-Control-Allow-Headers']],
                'maxAge' => (int) $answer['Access-Control-Max-Age'],
            ];
        });
        self::assertSame(Vectors::map($case['expect']), $result);
    }

    /**
     * The sequence against the real counter store in a fresh data folder.
     *
     * @param array<string, mixed> $case
     */
    #[DataProvider('limitSequence')]
    public function testLimitSequence(array $case): void
    {
        $dir = sys_get_temp_dir() . '/moat-limits-' . bin2hex(random_bytes(6));
        mkdir($dir, 0o700);
        $data = DataDir::create($dir);
        $counters = [];
        foreach (Vectors::list($case['limits']) as $index => $limit) {
            $limit = Vectors::map($limit);
            $counters[] = ['c' . $index, isset($limit['period'])
                ? new Quota(Vectors::int($limit['requests']), QuotaPeriod::from(Vectors::string($limit['period'])))
                : new Limit(Vectors::int($limit['requests']), Vectors::int($limit['windowSeconds']))];
        }
        $got = [];
        foreach (Vectors::list($case['times']) as $now) {
            $refusal = RateLimiter::hit($data, $counters, 100, Vectors::int($now));
            $got[] = ['allowed' => $refusal === null, 'retryAfter' => $refusal->retryAfter ?? 0, 'quota' => $refusal->quota ?? false];
        }
        self::assertSame(Vectors::list($case['expect']), $got);
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('client')]
    public function testClient(array $case): void
    {
        self::assertSame($case['expect'], ClientKey::of(Vectors::string($case['address'])));
    }

    /** @param array<string, mixed> $route `{method, origins}` of a cors.json case */
    private static function route(array $route): Route
    {
        return new Route(
            'r',
            Method::from(Vectors::string($route['method'])),
            '/r',
            'u',
            '/r',
            0,
            ['application/json'],
            ['application/json'],
            true,
            array_map(Vectors::string(...), array_values(Vectors::list($route['origins']))),
            null,
        );
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('body')]
    public function testBody(array $case): void
    {
        $name = Vectors::string($case['name']);
        $fields = BodySchema::parse(Vectors::strict('http/body.json', $name, 'fields'));
        $bytes = isset($case['bodyHex']) ? (string) hex2bin(Vectors::string($case['bodyHex'])) : Vectors::string($case['body']);
        $result = self::outcome(static fn(): array => ['body' => BodyValidator::validate($fields, $bytes)]);
        self::assertSame(Vectors::map($case['expect']), $result);
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('config')]
    public function testConfig(array $case): void
    {
        $name = Vectors::string($case['name']);
        $config = Vectors::strict('config/config.json', $name, 'config');
        $secrets = array_map(Vectors::string(...), array_values(Vectors::list($case['secrets'])));
        $result = self::outcome(static function () use ($config, $secrets): array {
            ConfigValidator::validate($config, $secrets);

            return [];
        });
        self::assertSame(Vectors::map($case['expect']), $result);
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('policy')]
    public function testPolicy(array $case): void
    {
        $name = Vectors::string($case['name']);
        $config = ConfigValidator::validate(Vectors::strict('config/policy.json', $name, 'config'), ['hubspot-token']);
        $policy = Vectors::strict('config/policy.json', $name, 'policy');
        $result = self::outcome(static function () use ($config, $policy): array {
            PolicyCheck::check($config, PolicyCheck::parse($policy));

            return [];
        });
        self::assertSame(Vectors::map($case['expect']), $result);
    }

    /**
     * @param callable(): array<string, mixed> $run
     *
     * @return array<string, mixed>
     */
    private static function outcome(callable $run): array
    {
        try {
            return ['ok' => true, ...$run()];
        } catch (Rejection $rejection) {
            return ['ok' => false, 'error' => $rejection->reason->value];
        }
    }
}
