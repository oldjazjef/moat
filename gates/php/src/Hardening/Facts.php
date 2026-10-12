<?php

declare(strict_types=1);

namespace Moat\Gate\Hardening;

/** Everything the hardening check classifies; the shape of `facts` in conformance/vectors/gate/hardening.json. */
final readonly class Facts
{
    public function __construct(
        public int $now,
        public ?WebFacts $web,
        public bool $dataPermissionsOpen,
        public PolicyState $policy,
        public External $external,
    ) {}
}
