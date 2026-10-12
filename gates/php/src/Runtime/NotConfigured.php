<?php

declare(strict_types=1);

namespace Moat\Gate\Runtime;

/** A data file is missing or invalid: the gate serves nothing (SEC-46). Carries no detail. */
final class NotConfigured extends \RuntimeException
{
    public function __construct()
    {
        parent::__construct('gate_not_configured');
    }
}
