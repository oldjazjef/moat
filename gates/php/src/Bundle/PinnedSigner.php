<?php

declare(strict_types=1);

namespace Moat\Gate\Bundle;

use Moat\Gate\Crypto\KeyAlgorithm;
use Moat\Gate\Crypto\KeyId;

/** A signing key pinned in the gate's local trust file (docs/CRYPTO.md §8). Ed25519 for now. */
final readonly class PinnedSigner
{
    public string $kid;

    public function __construct(public string $publicKey)
    {
        if (\strlen($publicKey) !== SODIUM_CRYPTO_SIGN_PUBLICKEYBYTES) {
            throw new \InvalidArgumentException('Ed25519 public key must be 32 bytes.');
        }
        $this->kid = KeyId::of(KeyAlgorithm::Ed25519, $publicKey);
    }
}
