<?php

declare(strict_types=1);

namespace Moat\Gate\Config;

/** FR-16: who may call a route (libs/core http/client.ts); every check that is set must pass. */
final readonly class ClientProtection
{
    /**
     * @param ?array{string, string}                                $apiKey    header, secret name
     * @param ?array{string, string, list<JwtKey>}                  $jwt       issuer, audience, keys
     * @param ?array{string, string, TokenEndpoint}                 $turnstile header, secret name, verify endpoint
     */
    public function __construct(
        public ?array $apiKey,
        public ?array $jwt,
        public ?array $turnstile,
        public ?string $honeypot,
    ) {}

    /** @return list<string> the secrets the checks open */
    public function secrets(): array
    {
        return array_values(array_filter([$this->apiKey[1] ?? null, $this->turnstile[1] ?? null], \is_string(...)));
    }
}
