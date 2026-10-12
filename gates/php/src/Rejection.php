<?php

declare(strict_types=1);

namespace Moat\Gate;

/**
 * Thrown for every rejection. The message is the code only — never an input value (SEC-34).
 */
final class Rejection extends \RuntimeException
{
    public function __construct(public readonly RejectionCode $reason)
    {
        parent::__construct($reason->value);
    }
}
