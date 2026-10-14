<?php

declare(strict_types=1);

namespace Moat\Gate\Config;

/** FR-16: a public key a route's JWT may be signed with; the algorithm belongs to the key. */
final readonly class JwtKey
{
    public function __construct(
        public string $kid,
        public JwtAlg $alg,
        /** DER SubjectPublicKeyInfo */
        public string $spki,
    ) {}
}
