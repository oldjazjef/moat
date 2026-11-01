<?php

declare(strict_types=1);

namespace Moat\Gate\Tests\Conformance;

use Moat\Gate\Runtime\TrafficReport;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/** The PHP gate against conformance/vectors/gate/traffic-report.json (FR-50, T-110): what it sends. */
final class TrafficReportVectorsTest extends TestCase
{
    /** @return iterable<string, array{array<string, mixed>}> */
    public static function cases(): iterable
    {
        return Vectors::cases('gate/traffic-report.json', 'build');
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('cases')]
    public function testBuild(array $case): void
    {
        $lines = [];
        foreach (Vectors::list($case['entries']) as $entry) {
            $lines[] = json_encode($entry, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
        }
        $sentUntil = $case['sentUntil'];
        [$report, $until] = TrafficReport::build(
            Vectors::string($case['gateId']),
            TrafficReport::entries($lines),
            $sentUntil === null ? null : Vectors::int($sentUntil),
            Vectors::int($case['now']),
        );
        $expect = Vectors::map($case['expect']);
        self::assertSame(Vectors::int($expect['until']), $until);
        if ($expect['report'] === null) {
            self::assertNull($report);

            return;
        }
        self::assertNotNull($report);
        $sent = TrafficReport::encode($report);
        // The vectors were read as arrays, where `{}` and `[]` look alike: compare as arrays, and
        // check on the bytes that no error map went out as a list.
        self::assertSame($expect['report'], json_decode($sent, true, 512, JSON_THROW_ON_ERROR));
        self::assertStringNotContainsString('"errors":[]', $sent);
    }

    public function testNoClientHashOrMethodLeavesTheGate(): void
    {
        $line = '{"t":7200,"route":"a","method":"POST","status":200,"error":null,"ms":1,"client":"fedcba9876543210"}';
        [$report] = TrafficReport::build('gateTrafficReport00000', TrafficReport::entries([$line]), 3600, 3 * 3600);
        self::assertNotNull($report);
        $text = TrafficReport::encode($report);
        self::assertStringNotContainsString('fedcba9876543210', $text);
        self::assertStringNotContainsString('POST', $text);
    }
}
