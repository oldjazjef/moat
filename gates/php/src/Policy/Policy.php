<?php

declare(strict_types=1);

namespace Moat\Gate\Policy;

use Moat\Gate\Runtime\RequestLog;

/**
 * The gate's local policy (SEC-10 to SEC-14): written only on the gate's server, never by the
 * Cloud. The shape is libs/core/src/policy/policy.ts.
 */
final readonly class Policy
{
    /**
     * @param array<string, PolicyUpstream> $upstreams by `host[:port]`
     * @param array<string, string>         $testResolve `host[:port]` → loopback IP (testing only)
     * @param ?non-empty-string             $testCaFile
     */
    public function __construct(
        public array $upstreams,
        public int $maxBodyBytes,
        public int $maxResponseBytes,
        public int $maxTimeoutMs,
        public PolicyLimits $limits,
        public bool $testing,
        public array $testResolve,
        public ?string $testCaFile,
        /** SEC-15, T-23: `status` warns when the active bundle is older (seconds); null = no warning. */
        public ?int $maxConfigAgeSeconds = null,
        /** DT-11: where and how often the gate looks for a new bundle; null = only `accept`. */
        public ?PolicyPull $pull = null,
        /** FR-50: bytes of the request log before it rolls over; 0 = no log. */
        public int $logMaxBytes = RequestLog::DEFAULT_MAX_BYTES,
    ) {}
}
