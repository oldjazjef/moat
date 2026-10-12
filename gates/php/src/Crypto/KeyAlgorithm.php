<?php

declare(strict_types=1);

namespace Moat\Gate\Crypto;

enum KeyAlgorithm: string
{
    case Ed25519 = 'ed25519';
    case X25519 = 'x25519';
    case WebAuthnEs256 = 'webauthn-es256';
}
