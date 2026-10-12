<?php

declare(strict_types=1);

namespace Moat\Gate\Runtime;

use Moat\Gate\Encoding\Base64Url;
use Moat\Gate\Json\JsonObject;
use Moat\Gate\Json\StrictJson;

/**
 * The gate's own identity, created on the server by `install` and never sent anywhere except the
 * public parts (SEC-30): the gate id (16 random bytes, base64url) and its X25519 box key pair.
 */
final readonly class Identity
{
    public string $boxPublicKey;

    private function __construct(
        public string $gateId,
        public string $boxSecretKey,
    ) {
        $this->boxPublicKey = sodium_crypto_scalarmult_base($boxSecretKey);
    }

    public static function generate(): self
    {
        $pair = sodium_crypto_box_keypair();
        $secretKey = sodium_crypto_box_secretkey($pair);
        sodium_memzero($pair);

        return new self(Base64Url::encode(random_bytes(16)), $secretKey);
    }

    public static function parse(string $bytes): self
    {
        $value = StrictJson::decode($bytes);
        if (!$value instanceof JsonObject || !$value->hasExactKeys('v', 'gateId', 'boxSecretKey') || $value->get('v') !== 1) {
            throw new NotConfigured();
        }
        $gateId = $value->get('gateId');
        if (!\is_string($gateId) || preg_match('/^[A-Za-z0-9_-]{22}$/D', $gateId) !== 1) {
            throw new NotConfigured();
        }

        return new self($gateId, Base64Url::decodeLength($value->get('boxSecretKey'), SODIUM_CRYPTO_BOX_SECRETKEYBYTES));
    }

    public function encode(): string
    {
        return json_encode(
            ['v' => 1, 'gateId' => $this->gateId, 'boxSecretKey' => Base64Url::encode($this->boxSecretKey)],
            JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES,
        ) . "\n";
    }
}
