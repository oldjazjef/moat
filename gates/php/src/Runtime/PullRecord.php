<?php

declare(strict_types=1);

namespace Moat\Gate\Runtime;

use Moat\Gate\Json\JsonObject;
use Moat\Gate\Json\StrictJson;
use Moat\Gate\Rejection;
use Moat\Gate\Storage\DataDir;

/**
 * The data file `pull` (DT-11): when the gate last looked for a bundle and how it ended — no
 * outcome yet while the fetch runs. Codes only; never a byte of what the place served.
 */
final readonly class PullRecord
{
    public function __construct(
        public int $attemptedAt,
        public ?PullOutcome $outcome,
        /** A RejectionCode, a GateError or an HTTP status: why it was not accepted. */
        public ?string $reason,
        /** The version that became active (Accepted only). */
        public ?int $version,
    ) {}

    /** Null when there is none, or it is damaged (the next request then pulls). */
    public static function read(DataDir $data): ?self
    {
        try {
            $bytes = $data->read(BundlePull::STATE);
            $value = $bytes === null ? null : StrictJson::decode($bytes);
        } catch (Rejection | \RuntimeException) {
            return null;
        }
        if (!$value instanceof JsonObject || !$value->hasExactKeys('v', 'attemptedAt', 'outcome', 'reason', 'version') || $value->get('v') !== 1) {
            return null;
        }
        $at = $value->get('attemptedAt');
        $outcome = $value->get('outcome');
        $reason = $value->get('reason');
        $version = $value->get('version');
        if (!\is_int($at) || !($outcome === null || \is_string($outcome)) || !($reason === null || \is_string($reason)) || !($version === null || \is_int($version))) {
            return null;
        }
        $parsed = $outcome === null ? null : PullOutcome::tryFrom($outcome);
        if ($outcome !== null && $parsed === null) {
            return null;
        }

        return new self($at, $parsed, $reason === null ? null : substr($reason, 0, 64), $version);
    }

    public function write(DataDir $data): void
    {
        $data->write(BundlePull::STATE, json_encode([
            'v' => 1,
            'attemptedAt' => $this->attemptedAt,
            'outcome' => $this->outcome?->value,
            'reason' => $this->reason,
            'version' => $this->version,
        ], JSON_THROW_ON_ERROR) . "\n");
    }
}
