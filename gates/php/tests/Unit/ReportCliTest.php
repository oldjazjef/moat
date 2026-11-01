<?php

declare(strict_types=1);

namespace Moat\Gate\Tests\Unit;

use Moat\Gate\Build\Builder;
use Moat\Gate\Encoding\Base64Url;
use Moat\Gate\Runtime\ReportSender;
use Moat\Gate\Storage\DataDir;
use Moat\Gate\Tests\Http\GateFixture;
use PHPUnit\Framework\TestCase;

/** `report`, the report line in `status` and the data file `report` (FR-50, T-110) through the built gate's CLI. */
final class ReportCliTest extends TestCase
{
    private const POLICY = '{"v":1,"upstreams":{"api.example.com":{"pathPrefixes":["/v1"],"methods":["POST"],"secrets":[]}},'
        . '"maxBodyBytes":4096,"maxResponseBytes":65536,"maxTimeoutMs":10000,"limits":{"perIp":{"requests":30,"windowSeconds":60},"total":{"requests":600,"windowSeconds":60},"maxClients":10000}%s}';
    private const TOKEN = 'TESTONLYreportAddress0000000000000000000000';
    private const REPORT = ',"report":{"url":"https://cloud.invalid/api/report/' . self::TOKEN . '","intervalSeconds":900}';

    private string $dir;

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/moat-report-cli-' . bin2hex(random_bytes(6));
        mkdir($this->dir, 0o700);
        file_put_contents($this->dir . '/' . GateFixture::GATE_FILE, Builder::build(\dirname(__DIR__, 2) . '/src', '0.0.0-test', 'test'));
        $signer = sodium_crypto_sign_keypair();
        [$status, $out] = $this->cli('install', '--signer=' . Base64Url::encode(sodium_crypto_sign_publickey($signer)));
        self::assertSame(0, $status, $out);
    }

    protected function tearDown(): void
    {
        GateFixture::remove($this->dir);
    }

    public function testReportWithoutAReportBlockIsAUsageError(): void
    {
        $this->policy('');
        [$status, $out] = $this->cli('report');
        self::assertSame(2, $status, $out);
        self::assertStringContainsString('no "report" block', $out);
        self::assertNull(ReportSender::state($this->data()));
    }

    public function testT110APlaceThatDoesNotAnswerKeepsTheCursorAndNeverShowsTheToken(): void
    {
        $this->policy(self::REPORT);
        [$status, $out] = $this->cli('report');
        self::assertSame(1, $status, $out);
        self::assertStringContainsString('Report to https://cloud.invalid/api/report/…: no usable answer (', $out);
        self::assertStringNotContainsString(self::TOKEN, $out);
        $state = ReportSender::state($this->data());
        self::assertNotNull($state);
        self::assertSame('failed', $state['outcome']);
        self::assertNull($state['sentUntil']);
        $status = $this->cli('status')[1];
        self::assertMatchesRegularExpression('#Report: +https://cloud\.invalid/api/report/… at most every 900 s; last .* no usable answer#', $status);
        self::assertStringNotContainsString(self::TOKEN, $status);
    }

    public function testStatusSaysNothingAboutAReportThePolicyDoesNotName(): void
    {
        $this->policy('');
        self::assertStringNotContainsString('Report:', $this->cli('status')[1]);
    }

    public function testT110ThePolicyRefusesAReportPlaceOutsideTheRules(): void
    {
        foreach ([
            '{"url":"http://cloud.example.com/api/report/x","intervalSeconds":900}',
            '{"url":"https://cloud.example.com/api/report?token=x","intervalSeconds":900}',
            '{"url":"https://127.0.0.1/api/report/x","intervalSeconds":900}',
            '{"url":"https://cloud.example.com/api/report/x","intervalSeconds":299}',
            '{"url":"https://cloud.example.com/api/report/x","intervalSeconds":900,"clients":true}',
        ] as $report) {
            file_put_contents($this->dir . '/policy.json', \sprintf(self::POLICY, ',"report":' . $report));
            self::assertNotSame(0, $this->cli('policy', $this->dir . '/policy.json')[0], $report);
        }
    }

    public function testSec46ADamagedReportRecordReadsAsNone(): void
    {
        $data = $this->data();
        foreach (['', '{}', '{"v":2,"attemptedAt":1,"sentUntil":null,"outcome":null,"reason":null}', 'not json', '{"v":1,"attemptedAt":"1","sentUntil":null,"outcome":null,"reason":null}'] as $bytes) {
            $data->write(ReportSender::STATE, $bytes);
            self::assertNull(ReportSender::state($data), $bytes);
        }
    }

    private function policy(string $report): void
    {
        file_put_contents($this->dir . '/policy.json', \sprintf(self::POLICY, $report));
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
