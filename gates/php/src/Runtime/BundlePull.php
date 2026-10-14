<?php

declare(strict_types=1);

namespace Moat\Gate\Runtime;

use Moat\Gate\Bundle\BundleVerifier;
use Moat\Gate\Http\GateError;
use Moat\Gate\Policy\PolicyPull;
use Moat\Gate\Rejection;
use Moat\Gate\Upstream\UpstreamClient;

/**
 * The lazy pull (DT-11, ANFORDERUNGEN.md §4.3): when the local policy names a place and its
 * interval is over, one request fetches the file there and hands it to `accept` — the same
 * checks as on the command line (signature, gate id, version, schema, policy). Nothing else
 * happens with it: whatever the place serves, the worst outcome is that the active bundle stays.
 * The request is served either way. The data file `pull` records the last attempt (written
 * before the fetch, under the lock `pulllock`), so concurrent requests fetch at most once per
 * interval and a place that hangs is not asked by every request.
 */
final class BundlePull
{
    public const STATE = 'pull';
    public const LOCK = 'pulllock';

    /** Pulls when the interval is over; null when it is not (or another request is pulling). */
    public static function ifDue(Gate $gate, int $now): ?PullRecord
    {
        $pull = $gate->policy?->pull;
        if ($pull === null || !self::due(PullRecord::read($gate->data), $pull, $now)) {
            return null;
        }
        try {
            $claimed = $gate->data->locked(static function () use ($gate, $pull, $now): bool {
                if (!self::due(PullRecord::read($gate->data), $pull, $now)) {
                    return false;
                }
                (new PullRecord($now, null, null, null))->write($gate->data);

                return true;
            }, self::LOCK);
        } catch (\RuntimeException) {
            // Another request holds the lock: it is pulling right now.
            return null;
        }

        return $claimed ? self::pull($gate, $pull, $now) : null;
    }

    /** `php moat-gate.php pull`: now, whatever the interval says. */
    public static function now(Gate $gate, int $now): ?PullRecord
    {
        $pull = $gate->policy?->pull;
        if ($pull === null) {
            return null;
        }
        $gate->data->locked(static function () use ($gate, $now): void {
            (new PullRecord($now, null, null, null))->write($gate->data);
        }, self::LOCK);

        return self::pull($gate, $pull, $now);
    }

    private static function due(?PullRecord $last, PolicyPull $pull, int $now): bool
    {
        // A record from the future (a clock set back) does not stop pulling for long.
        return $last === null || $now - $last->attemptedAt >= $pull->intervalSeconds || $last->attemptedAt > $now + 60;
    }

    private static function pull(Gate $gate, PolicyPull $pull, int $now): PullRecord
    {
        $answer = UpstreamClient::fetch($pull->host, $pull->port, $pull->path, BundleVerifier::MAX_ENVELOPE_BYTES, $gate->policy);
        if ($answer instanceof GateError) {
            $record = new PullRecord($now, PullOutcome::Failed, $answer->value, null);
        } elseif ($answer[0] !== 200) {
            $record = new PullRecord($now, PullOutcome::HttpStatus, (string) $answer[0], null);
        } else {
            $record = self::offer($gate, $answer[1], $now);
        }
        $record->write($gate->data);

        return $record;
    }

    private static function offer(Gate $gate, string $bytes, int $now): PullRecord
    {
        $active = $gate->data->read(Gate::BUNDLE);
        if ($active !== null && hash_equals(hash('sha256', $active), hash('sha256', $bytes))) {
            return new PullRecord($now, PullOutcome::Unchanged, null, null);
        }
        try {
            $accepted = $gate->accept($bytes, $now);
        } catch (Rejection $rejection) {
            return new PullRecord($now, PullOutcome::Rejected, $rejection->reason->value, null);
        } catch (NotConfigured) {
            return new PullRecord($now, PullOutcome::Rejected, 'not_installed', null);
        }

        return new PullRecord($now, PullOutcome::Accepted, null, $accepted->version);
    }
}
