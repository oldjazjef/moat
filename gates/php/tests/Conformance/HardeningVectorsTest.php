<?php

declare(strict_types=1);

namespace Moat\Gate\Tests\Conformance;

use Moat\Gate\Hardening\External;
use Moat\Gate\Hardening\Facts;
use Moat\Gate\Hardening\Finding;
use Moat\Gate\Hardening\Hardening;
use Moat\Gate\Hardening\PolicyState;
use Moat\Gate\Hardening\WebFacts;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/** The PHP gate against conformance/vectors/gate/hardening.json (SEC-49, SEC-49a), as libs/core. */
final class HardeningVectorsTest extends TestCase
{
    /** @return iterable<string, array{array<string, mixed>}> */
    public static function cases(): iterable
    {
        return Vectors::cases('gate/hardening.json');
    }

    public function testFindingsUsersAndLimitAreTheCores(): void
    {
        $doc = Vectors::load('gate/hardening.json');
        $severities = [];
        foreach (Finding::cases() as $finding) {
            $severities[$finding->value] = $finding->severity();
        }
        self::assertSame($doc['findings'], $severities);
        $blocking = array_values(array_map(static fn(Finding $finding): string => $finding->value, array_filter(Finding::cases(), static fn(Finding $finding): bool => $finding->blocksLevel())));
        self::assertSame($doc['blocksLevel'], $blocking);
        self::assertSame($doc['genericUsers'], Hardening::GENERIC_WEB_USERS);
        self::assertSame($doc['staleSeconds'], Hardening::STALE_SECONDS);
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('cases')]
    public function testCase(array $case): void
    {
        $facts = self::object($case['facts'] ?? null);
        $web = $facts['web'] ?? null;
        $web = $web === null ? null : self::object($web);
        $now = $facts['now'] ?? null;
        $permissions = $facts['dataPermissionsOpen'] ?? null;
        $user = $web['user'] ?? null;
        $owns = $web['ownsFiles'] ?? null;
        self::assertIsInt($now);
        self::assertIsBool($permissions);
        $webFacts = null;
        if ($web !== null) {
            self::assertIsInt($web['at']);
            self::assertTrue($user === null || \is_string($user));
            self::assertTrue($owns === null || \is_bool($owns));
            self::assertIsBool($web['openBasedir']);
            self::assertIsBool($web['codeWritable']);
            self::assertIsBool($web['allowUrlInclude']);
            $webFacts = new WebFacts($web['at'], 'test', $user, null, $owns, $web['openBasedir'], $web['codeWritable'], $web['allowUrlInclude'], null);
        }
        $report = Hardening::classify(new Facts(
            $now,
            $webFacts,
            $permissions,
            PolicyState::from(self::string($facts['policy'] ?? null)),
            External::from(self::string($facts['external'] ?? null)),
        ));
        self::assertSame($case['expect'], [
            'level' => $report->level?->value,
            'findings' => array_map(static fn(Finding $finding): string => $finding->value, $report->findings),
        ]);
    }

    /** @return array<string, mixed> */
    private static function object(mixed $value): array
    {
        self::assertIsArray($value);

        /** @var array<string, mixed> $value */
        return $value;
    }

    private static function string(mixed $value): string
    {
        self::assertIsString($value);

        return $value;
    }
}
