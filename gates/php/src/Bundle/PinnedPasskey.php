<?php

declare(strict_types=1);

namespace Moat\Gate\Bundle;

use Moat\Gate\Crypto\Es256;
use Moat\Gate\Crypto\KeyAlgorithm;
use Moat\Gate\Crypto\KeyId;

/**
 * A passkey pinned in the gate's local trust file in trust mode 2 (docs/CRYPTO.md §7.1): the
 * uncompressed P-256 point, the relying party id and the exact origins the ceremony may run on.
 */
final readonly class PinnedPasskey
{
    public const MAX_ORIGINS = 8;

    public string $kid;
    public KeyAlgorithm $alg;

    /** @param list<string> $origins */
    public function __construct(public string $publicKey, public string $rpId, public array $origins)
    {
        if (\strlen($publicKey) !== Es256::POINT_BYTES || $publicKey[0] !== "\x04") {
            throw new \InvalidArgumentException('A passkey is a 65-byte uncompressed P-256 point.');
        }
        if (!Es256::isRpId($rpId)) {
            throw new \InvalidArgumentException('The rpId must be a lower-case DNS name.');
        }
        if ($origins === [] || \count($origins) > self::MAX_ORIGINS || \count(array_unique($origins)) !== \count($origins)) {
            throw new \InvalidArgumentException('A passkey pins 1 to ' . self::MAX_ORIGINS . ' different origins.');
        }
        foreach ($origins as $origin) {
            if (!Es256::isOrigin($origin)) {
                throw new \InvalidArgumentException('An origin must be https://<host>[:<port>] or app://<name>.');
            }
        }
        $this->alg = KeyAlgorithm::WebAuthnEs256;
        $this->kid = KeyId::of(KeyAlgorithm::WebAuthnEs256, $publicKey);
    }
}
