<?php

declare(strict_types=1);

namespace Moat\Gate\Http;

/** Ends a request with one GateError. `$allow` fills the Allow header of a 405. */
final class Failure extends \RuntimeException
{
    /** @param list<string> $allow */
    public function __construct(public readonly GateError $error, public readonly array $allow = [])
    {
        parent::__construct($error->value);
    }
}
