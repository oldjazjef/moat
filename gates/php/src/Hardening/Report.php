<?php

declare(strict_types=1);

namespace Moat\Gate\Hardening;

final readonly class Report
{
    /** @param list<Finding> $findings in the order of Finding::cases() */
    public function __construct(
        public ?Level $level,
        public array $findings,
    ) {}
}
