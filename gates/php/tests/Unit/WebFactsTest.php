<?php

declare(strict_types=1);

namespace Moat\Gate\Tests\Unit;

use Moat\Gate\Hardening\WebFacts;
use Moat\Gate\Storage\DataDir;
use Moat\Gate\Tests\Http\GateFixture;
use PHPUnit\Framework\TestCase;

/** What the web process records for the hardening check (SEC-49, SEC-49a), and the folder's permissions. */
final class WebFactsTest extends TestCase
{
    private string $dir;
    private string $gateFile;
    private DataDir $data;
    /** This process's user id, read from a file it created (CI has no posix extension). */
    private int $uid;

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/moat-webfacts-' . bin2hex(random_bytes(6));
        mkdir($this->dir, 0o700);
        $this->gateFile = $this->dir . '/moat-gate.php';
        file_put_contents($this->gateFile, "<?php\n");
        $owner = fileowner($this->gateFile);
        self::assertIsInt($owner);
        $this->uid = $owner;
        $this->data = DataDir::create($this->dir);
    }

    protected function tearDown(): void
    {
        GateFixture::remove($this->dir);
    }

    public function testRecordsTheProcessItRunsAs(): void
    {
        WebFacts::record($this->data, $this->gateFile, 1_000);
        $facts = WebFacts::read($this->data);
        self::assertNotNull($facts);
        self::assertSame(1_000, $facts->at);
        self::assertSame(PHP_SAPI, $facts->sapi);
        self::assertSame($this->uid, $facts->uid);
        // The test wrote the gate file, so the process owns it.
        self::assertTrue($facts->ownsFiles);
        self::assertTrue($facts->codeWritable);
    }

    public function testRewritesOnlyOnceADayWhenNothingChanged(): void
    {
        WebFacts::record($this->data, $this->gateFile, 1_000);
        WebFacts::record($this->data, $this->gateFile, 1_000 + WebFacts::REFRESH_SECONDS - 1);
        self::assertSame(1_000, WebFacts::read($this->data)?->at);
        WebFacts::record($this->data, $this->gateFile, 1_000 + WebFacts::REFRESH_SECONDS);
        self::assertSame(1_000 + WebFacts::REFRESH_SECONDS, WebFacts::read($this->data)?->at);
    }

    public function testRewritesAtOnceWhenSomethingChanged(): void
    {
        WebFacts::record($this->data, $this->gateFile, 1_000);
        // Root may write anything, so there the gate file changes owner instead.
        $root = $this->uid === 0;
        if ($root) {
            chown($this->gateFile, 54321);
        } else {
            chmod($this->gateFile, 0o444);
        }
        WebFacts::record($this->data, $this->gateFile, 1_001);
        $facts = WebFacts::read($this->data);
        self::assertNotNull($facts);
        self::assertSame(1_001, $facts->at);
        self::assertSame($root, $facts->codeWritable);
        self::assertSame(!$root, $facts->ownsFiles);
    }

    public function testCopiesTheNonceOfAPendingCheck(): void
    {
        WebFacts::record($this->data, $this->gateFile, 1_000);
        self::assertNull(WebFacts::read($this->data)?->check);
        $nonce = bin2hex(random_bytes(16));
        $this->data->write(WebFacts::CHECK_REQUEST, $nonce . "\n");
        // Recorded at once, not only after a day.
        WebFacts::record($this->data, $this->gateFile, 1_001);
        self::assertSame($nonce, WebFacts::read($this->data)?->check);
        $this->data->write(WebFacts::CHECK_REQUEST, "not a nonce\n");
        WebFacts::record($this->data, $this->gateFile, 1_002);
        self::assertNull(WebFacts::read($this->data)?->check);
    }

    public function testDamagedOrForeignFactsCountAsNotSeen(): void
    {
        foreach ([
            '{"v":1}',
            '{"v":2,"at":1,"sapi":"x","user":null,"uid":null,"ownsFiles":null,"openBasedir":false,"codeWritable":false,"allowUrlInclude":false,"check":null}',
            '{"v":1,"at":"1","sapi":"x","user":null,"uid":null,"ownsFiles":null,"openBasedir":false,"codeWritable":false,"allowUrlInclude":false,"check":null}',
            '{"v":1,"at":1,"sapi":"x","user":null,"uid":null,"ownsFiles":null,"openBasedir":0,"codeWritable":false,"allowUrlInclude":false,"check":null}',
            '{"v":1,"at":1,"sapi":"x","user":null,"uid":null,"ownsFiles":null,"openBasedir":false,"codeWritable":false,"allowUrlInclude":false,"check":null,"level":"h3"}',
            'not json',
        ] as $bytes) {
            $this->data->write(WebFacts::FILE, $bytes);
            self::assertNull(WebFacts::read($this->data));
        }
        file_put_contents($this->data->path . '/webfacts.php', 'no marker');
        self::assertNull(WebFacts::read($this->data));
    }

    public function testPermissions(): void
    {
        $this->data->write('identity', '{}');
        self::assertFalse($this->data->permissionsOpen());
        self::assertSame(['identity.php'], $this->data->fileNames());
        chmod($this->data->path . '/identity.php', 0o640);
        self::assertTrue($this->data->permissionsOpen());
        chmod($this->data->path . '/identity.php', 0o600);
        chmod($this->data->path, 0o755);
        self::assertTrue($this->data->permissionsOpen());
    }
}
