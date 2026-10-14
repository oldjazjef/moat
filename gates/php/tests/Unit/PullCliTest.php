<?php

declare(strict_types=1);

namespace Moat\Gate\Tests\Unit;

use Moat\Gate\Build\Builder;
use Moat\Gate\Encoding\Base64Url;
use Moat\Gate\Runtime\BundlePull;
use Moat\Gate\Runtime\PullOutcome;
use Moat\Gate\Runtime\PullRecord;
use Moat\Gate\Storage\DataDir;
use Moat\Gate\Tests\Http\GateFixture;
use PHPUnit\Framework\TestCase;

/** `pull`, the pull line in `status` and the data file `pull` (DT-11) through the built gate's CLI. */
final class PullCliTest extends TestCase
{
    private const POLICY = '{"v":1,"upstreams":{"api.example.com":{"pathPrefixes":["/v1"],"methods":["POST"],"secrets":[]}},'
        . '"maxBodyBytes":4096,"maxResponseBytes":65536,"maxTimeoutMs":10000,"limits":{"perIp":{"requests":30,"windowSeconds":60},"total":{"requests":600,"windowSeconds":60},"maxClients":10000}%s}';
    private const PULL = ',"pull":{"url":"https://bundles.invalid/moat/www.json","intervalSeconds":300}';

    private string $dir;
    /** @var non-empty-string */
    private string $signer;
    private string $gateId = '';

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/moat-pull-cli-' . bin2hex(random_bytes(6));
        mkdir($this->dir, 0o700);
        file_put_contents($this->dir . '/' . GateFixture::GATE_FILE, Builder::build(\dirname(__DIR__, 2) . '/src', '0.0.0-test', 'test'));
        $this->signer = sodium_crypto_sign_keypair();
        [$status, $out] = $this->cli('install', '--signer=' . Base64Url::encode(sodium_crypto_sign_publickey($this->signer)));
        self::assertSame(0, $status, $out);
        if (preg_match('/--gate-id=(\S+)/', $out, $match) !== 1) {
            self::fail('install printed no gate id: ' . $out);
        }
        $this->gateId = $match[1];
    }

    protected function tearDown(): void
    {
        GateFixture::remove($this->dir);
    }

    public function testPullWithoutAPullBlockIsAUsageError(): void
    {
        $this->policy('');
        [$status, $out] = $this->cli('pull');
        self::assertSame(2, $status, $out);
        self::assertStringContainsString('no "pull" block', $out);
        self::assertNull(PullRecord::read($this->data()));
    }

    public function testSec46APlaceThatDoesNotAnswerKeepsTheGateAsItIsAndIsRecorded(): void
    {
        $this->policy(self::PULL);
        [$status, $out] = $this->cli('pull');
        self::assertSame(1, $status, $out);
        self::assertStringContainsString('Pulled https://bundles.invalid/moat/www.json: no usable answer (', $out);
        $record = PullRecord::read($this->data());
        self::assertNotNull($record);
        self::assertSame(PullOutcome::Failed, $record->outcome);
        self::assertNull($record->version);
    }

    public function testStatusShowsThePullAndItsLastAttempt(): void
    {
        $this->policy(self::PULL);
        self::assertStringContainsString(
            'Pull:       https://bundles.invalid/moat/www.json at most every 300 s; not tried yet',
            $this->cli('status')[1],
        );
        $this->cli('pull');
        self::assertMatchesRegularExpression('/Pull: .* last \d{4}-\d\d-\d\d \d\d:\d\d UTC, no usable answer/', $this->cli('status')[1]);
    }

    public function testStatusSaysNothingAboutAPullThePolicyDoesNotName(): void
    {
        $this->policy('');
        self::assertStringNotContainsString('Pull:', $this->cli('status')[1]);
    }

    public function testDt11ThePolicyRefusesAPullPlaceOutsideTheRules(): void
    {
        foreach ([
            '{"url":"http://bundles.example.com/www.json","intervalSeconds":300}',
            '{"url":"https://bundles.example.com/www.json?v=1","intervalSeconds":300}',
            '{"url":"https://bundles.example.com/../www.json","intervalSeconds":300}',
            '{"url":"https://user@bundles.example.com/www.json","intervalSeconds":300}',
            '{"url":"https://127.0.0.1/www.json","intervalSeconds":300}',
            '{"url":"https://bundles.example.com/www.json","intervalSeconds":59}',
            '{"url":"https://bundles.example.com/www.json","intervalSeconds":300,"token":"x"}',
        ] as $pull) {
            file_put_contents($this->dir . '/policy.json', \sprintf(self::POLICY, ',"pull":' . $pull));
            self::assertNotSame(0, $this->cli('policy', $this->dir . '/policy.json')[0], $pull);
        }
    }

    public function testSec46ADamagedPullRecordReadsAsNone(): void
    {
        $data = $this->data();
        foreach (['', '{}', '{"v":1,"attemptedAt":1,"outcome":"exploded","reason":null,"version":null}', '{"v":2,"attemptedAt":1,"outcome":null,"reason":null,"version":null}', 'not json'] as $bytes) {
            $data->write(BundlePull::STATE, $bytes);
            self::assertNull(PullRecord::read($data), $bytes);
        }
        (new PullRecord(7, PullOutcome::Accepted, null, 3))->write($data);
        self::assertEquals(new PullRecord(7, PullOutcome::Accepted, null, 3), PullRecord::read($data));
    }

    public function testSec04AcceptWaitsForAPullThatIsAcceptingRightNow(): void
    {
        $this->policy(self::PULL);
        $config = json_decode(
            '{"version":1,"upstreams":{"api":{"origin":"https://api.example.com","auth":null,"timeoutMs":5000}},'
            . '"routes":{"status":{"method":"POST","path":"/status","upstream":"api","upstreamPath":"/v1","maxBodyBytes":1024,'
            . '"contentTypes":["application/json"],"responseContentTypes":["application/json"],"enabled":true,"origins":[],"rateLimit":null}}}',
            false,
            512,
            JSON_THROW_ON_ERROR,
        );
        file_put_contents($this->dir . '/bundle.json', GateFixture::bundle($config, [], $this->gateId, $this->signer, 1, time()));
        // A pull holds the lock while it accepts: `accept` on the command line does not slip in between.
        $this->data()->locked(function (): void {
            self::assertNotSame(0, $this->cli('accept', $this->dir . '/bundle.json')[0]);
        }, BundlePull::LOCK);
        self::assertNull($this->data()->read('state'));
        [$status, $out] = $this->cli('accept', $this->dir . '/bundle.json');
        self::assertSame(0, $status, $out);
    }

    private function policy(string $pull): void
    {
        file_put_contents($this->dir . '/policy.json', \sprintf(self::POLICY, $pull));
        [$status, $out] = $this->cli('policy', $this->dir . '/policy.json');
        self::assertSame(0, $status, $out);
    }

    private function data(): DataDir
    {
        clearstatcache();

        return DataDir::locate($this->dir) ?? throw new \RuntimeException('no data folder');
    }

    /** @return array{int, string} */
    private function cli(string ...$args): array
    {
        $outFile = $this->dir . '/cli.out';
        $process = proc_open([PHP_BINARY, $this->dir . '/' . GateFixture::GATE_FILE, ...array_values($args)], [1 => ['file', $outFile, 'w'], 2 => ['file', $outFile, 'a']], $pipes);
        if ($process === false) {
            throw new \RuntimeException('cannot start the gate CLI');
        }
        $status = proc_close($process);

        return [$status, (string) file_get_contents($outFile)];
    }
}
