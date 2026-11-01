<?php

declare(strict_types=1);

namespace Moat\Gate\Runtime;

use Moat\Gate\Http\GateError;
use Moat\Gate\Json\JsonObject;
use Moat\Gate\Json\StrictJson;
use Moat\Gate\Policy\PolicyReport;
use Moat\Gate\Rejection;
use Moat\Gate\Storage\DataDir;
use Moat\Gate\Upstream\UpstreamClient;

/**
 * Sends the traffic report (FR-50, T-110) when the local policy names a report address and its
 * interval is over: after the answer to a request has gone out, under the lock `reportlock`, at
 * most once per interval. The data file `report` keeps the last attempt and the cursor (the
 * first hour not yet taken); the cursor moves only when the place answered 2xx, so a lost report
 * is sent again. Nothing the place answers is used, and a failure never touches a request.
 */
final class ReportSender
{
    public const STATE = 'report';
    public const LOCK = 'reportlock';
    /** How many log lines are read: both files at their largest hold fewer. */
    private const MAX_LINES = 50_000;

    /** @return array{attemptedAt: int, sentUntil: ?int, outcome: ?string, reason: ?string}|null */
    public static function state(DataDir $data): ?array
    {
        try {
            $bytes = $data->read(self::STATE);
            $value = $bytes === null ? null : StrictJson::decode($bytes);
        } catch (Rejection | \RuntimeException) {
            return null;
        }
        if (!$value instanceof JsonObject || !$value->hasExactKeys('v', 'attemptedAt', 'sentUntil', 'outcome', 'reason') || $value->get('v') !== 1) {
            return null;
        }
        $at = $value->get('attemptedAt');
        $until = $value->get('sentUntil');
        $outcome = $value->get('outcome');
        $reason = $value->get('reason');
        if (!\is_int($at) || !($until === null || \is_int($until)) || !($outcome === null || \is_string($outcome)) || !($reason === null || \is_string($reason))) {
            return null;
        }

        return ['attemptedAt' => $at, 'sentUntil' => $until, 'outcome' => $outcome, 'reason' => $reason === null ? null : substr($reason, 0, 64)];
    }

    /** Sends when the interval is over; null when it is not, or another request is sending. */
    public static function ifDue(Gate $gate, int $now): ?string
    {
        $report = $gate->policy?->report;
        if ($report === null || !self::due(self::state($gate->data), $report, $now)) {
            return null;
        }
        try {
            $claim = $gate->data->locked(static function () use ($gate, $report, $now): ?array {
                $state = self::state($gate->data);
                if (!self::due($state, $report, $now)) {
                    return null;
                }
                self::write($gate->data, $now, $state['sentUntil'] ?? null, null, null);

                return ['until' => $state['sentUntil'] ?? null];
            }, self::LOCK);
        } catch (\RuntimeException) {
            return null;
        }
        if (!\is_array($claim)) {
            return null;
        }
        $until = $claim['until'] ?? null;

        return self::send($gate, $report, \is_int($until) ? $until : null, $now);
    }

    /** `php moat-gate.php report`: now, whatever the interval says. Null without a report block. */
    public static function now(Gate $gate, int $now): ?string
    {
        $report = $gate->policy?->report;
        if ($report === null) {
            return null;
        }
        $cursor = $gate->data->locked(static function () use ($gate, $now): ?int {
            $until = self::state($gate->data)['sentUntil'] ?? null;
            self::write($gate->data, $now, $until, null, null);

            return $until;
        }, self::LOCK);

        return self::send($gate, $report, \is_int($cursor) ? $cursor : null, $now);
    }

    /** @param array{attemptedAt: int, sentUntil: ?int, outcome: ?string, reason: ?string}|null $last */
    private static function due(?array $last, PolicyReport $report, int $now): bool
    {
        return $last === null || $now - $last['attemptedAt'] >= $report->intervalSeconds || $last['attemptedAt'] > $now + 60;
    }

    /** The outcome: `sent`, `nothing` (no complete hour yet), `failed <error>` or `status <n>`. */
    private static function send(Gate $gate, PolicyReport $report, ?int $sentUntil, int $now): string
    {
        $entries = TrafficReport::entries(RequestLog::lines($gate->data, self::MAX_LINES));
        [$body, $until] = TrafficReport::build($gate->identity->gateId, $entries, $sentUntil, $now);
        if ($body === null) {
            self::write($gate->data, $now, $sentUntil, 'nothing', null);

            return 'nothing';
        }
        $answer = UpstreamClient::post($report->host, $report->port, $report->path, TrafficReport::encode($body), $gate->policy);
        if ($answer instanceof GateError) {
            self::write($gate->data, $now, $sentUntil, 'failed', $answer->value);

            return 'failed ' . $answer->value;
        }
        if ($answer < 200 || $answer > 299) {
            self::write($gate->data, $now, $sentUntil, 'status', (string) $answer);

            return 'status ' . $answer;
        }
        self::write($gate->data, $now, $until, 'sent', null);

        return 'sent';
    }

    private static function write(DataDir $data, int $now, ?int $sentUntil, ?string $outcome, ?string $reason): void
    {
        $data->write(self::STATE, json_encode([
            'v' => 1,
            'attemptedAt' => $now,
            'sentUntil' => $sentUntil,
            'outcome' => $outcome,
            'reason' => $reason,
        ], JSON_THROW_ON_ERROR) . "\n");
    }
}
