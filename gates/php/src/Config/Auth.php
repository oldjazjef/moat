<?php

declare(strict_types=1);

namespace Moat\Gate\Config;

/**
 * `name` is the header name (Header), the query parameter (Query), the user name (Basic) or the
 * client id (OAuth2); unused for Bearer. `token` only for OAuth2.
 */
final readonly class Auth
{
    public function __construct(
        public AuthType $type,
        public string $name,
        public string $secret,
        public ?TokenEndpoint $token = null,
    ) {}
}
