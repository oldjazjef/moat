<?php

declare(strict_types=1);

namespace Moat\Gate\Tests\Conformance;

use Moat\Gate\Config\ConfigValidator;
use Moat\Gate\Http\ContentType;
use Moat\Gate\Http\PathNormaliser;
use Moat\Gate\Policy\PolicyCheck;
use Moat\Gate\Rejection;
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
    public static function contentType(): iterable
    {
        return Vectors::cases('http/content-type.json');
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
