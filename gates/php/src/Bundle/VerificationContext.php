<?php

declare(strict_types=1);

namespace Moat\Gate\Bundle;

/** What the gate has pinned locally plus its own state — never anything from the Cloud. */
final readonly class VerificationContext
{
    /**
     * @param list<PinnedSigner|PinnedPasskey> $signers keys of the active trust mode (one kind, never mixed)
     * @param int                $threshold valid signatures required (at least 1 is enforced)
     * @param int                $currentVersion highest version accepted so far; 0 before the first
     * @param int                $now       seconds since the epoch
     * @param bool               $expiryEnabled SEC-05: expiry is opt-in
     */
    public function __construct(
        public string $gateId,
        public array $signers,
        public int $threshold,
        public int $currentVersion,
        public int $now,
        public bool $expiryEnabled,
    ) {}
}
