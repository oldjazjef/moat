<?php

declare(strict_types=1);

namespace Moat\Gate\Bundle;

use Moat\Gate\Json\JsonObject;

/** An authentic bundle for this gate. Schema and policy (steps 9–10) still follow. */
final readonly class VerifiedBundle
{
    public function __construct(
        public string $gateId,
        public int $version,
        public int $issuedAt,
        public ?int $expiresAt,
        public JsonObject $config,
        public JsonObject $secrets,
        public string $payloadBytes,
    ) {}
}
