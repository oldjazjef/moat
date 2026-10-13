<?php

declare(strict_types=1);

namespace Moat\Gate\Tests\Conformance;

use Moat\Gate\Runtime\KillSwitch;
use Moat\Gate\Storage\DataDir;
use Moat\Gate\Tests\Http\GateFixture;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/** The PHP gate against conformance/vectors/gate/kill-switch.json (SEC-15), through a real data folder. */
final class KillSwitchVectorsTest extends TestCase
{
    /** @return iterable<string, array{array<string, mixed>}> */
    public static function cases(): iterable
    {
        return Vectors::cases('gate/kill-switch.json');
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('cases')]
    public function testCase(array $case): void
    {
        $dir = sys_get_temp_dir() . '/moat-kill-' . bin2hex(random_bytes(6));
        mkdir($dir, 0o700);
        try {
            $data = DataDir::create($dir);
            $file = $case['file'] ?? null;
            if ($file === 'damaged') {
                file_put_contents($data->path . '/kill.php', '');
            } elseif ($file !== 'absent') {
                $data->write(KillSwitch::FILE, Vectors::string(Vectors::map($file)['content'] ?? null));
            }
            $switch = KillSwitch::read($data);
            self::assertSame(Vectors::map($case['expect']), ['gate' => $switch->gate, 'routes' => $switch->routes]);
        } finally {
            GateFixture::remove($dir);
        }
    }

    public function testKillAndReviveWriteWhatTheyRead(): void
    {
        $switch = KillSwitch::parse('')->killRoute('status')->killRoute('newsletter')->killRoute('status');
        self::assertSame(['newsletter', 'status'], KillSwitch::parse($switch->text())->routes);
        $switch = $switch->killGate()->reviveRoute('status');
        $read = KillSwitch::parse($switch->text());
        self::assertTrue($read->gate);
        self::assertSame(['newsletter'], $read->routes);
        self::assertFalse($read->isOff());
        self::assertTrue(KillSwitch::parse('')->isOff());
    }
}
