<?php

declare(strict_types=1);

namespace Moat\Gate\Config;

/** A budget's cost in the upstream's currency, in millionths ("micros"): limit and prices per million tokens. */
final readonly class Cost
{
    public function __construct(
        public int $limitMicros,
        public int $inputMicrosPerMillion,
        public int $outputMicrosPerMillion,
    ) {}
}
