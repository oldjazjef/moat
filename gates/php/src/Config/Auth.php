<?php

declare(strict_types=1);

namespace Moat\Gate\Config;

/** `name` is the header name (Header) or query parameter (Query); unused for Bearer. */
final readonly class Auth
{
    public function __construct(
        public AuthType $type,
        public string $name,
        public string $secret,
    ) {}
}
