<?php

declare(strict_types=1);

namespace Moat\Gate\Config;

/** Tokens one upstream answer used, split as providers bill them (FR-31). */
final readonly class Usage
{
    public function __construct(
        public int $input,
        public int $output,
    ) {}
}
