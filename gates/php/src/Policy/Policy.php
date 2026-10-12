<?php

declare(strict_types=1);

namespace Moat\Gate\Policy;

/**
 * The gate's local policy (SEC-10 to SEC-14): written only on the gate's server, never by the
 * Cloud. The shape is libs/core/src/policy/policy.ts.
 */
final readonly class Policy
{
    /**
     * @param array<string, PolicyUpstream> $upstreams by `host[:port]`
     * @param array<string, string>         $testResolve `host[:port]` → loopback IP (testing only)
     */
    public function __construct(
        public array $upstreams,
        public int $maxBodyBytes,
        public int $maxResponseBytes,
        public int $maxTimeoutMs,
        public bool $testing,
        public array $testResolve,
        public ?string $testCaFile,
    ) {}
}
