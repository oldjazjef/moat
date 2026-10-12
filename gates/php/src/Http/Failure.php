<?php

declare(strict_types=1);

namespace Moat\Gate\Http;

/**
 * Ends a request with one GateError. `$headers` are the few the error needs: Allow on a 405,
 * Retry-After on a 429, and the CORS headers once the origin was accepted.
 */
final class Failure extends \RuntimeException
{
    /** @param array<string, string> $headers */
    public function __construct(public readonly GateError $error, public readonly array $headers = [])
    {
        parent::__construct($error->value);
    }

    /**
     * The same failure with more headers (CORS, added on the way out).
     *
     * @param array<string, string> $headers
     */
    public function with(array $headers): self
    {
        return new self($this->error, $headers + $this->headers);
    }
}
