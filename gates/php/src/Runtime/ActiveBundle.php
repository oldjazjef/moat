<?php

declare(strict_types=1);

namespace Moat\Gate\Runtime;

use Moat\Gate\Config\CompiledConfig;
use Moat\Gate\Json\JsonObject;
use Moat\Gate\Policy\Policy;

/** A bundle that passed steps 1–9 against the current trust and policy: what requests run on. */
final readonly class ActiveBundle
{
    public function __construct(
        public int $version,
        public CompiledConfig $config,
        public JsonObject $secrets,
        public Policy $policy,
        /** When the bundle was signed (unix seconds): `status` warns when it is older than the policy allows (T-23). */
        public int $issuedAt,
    ) {}
}
