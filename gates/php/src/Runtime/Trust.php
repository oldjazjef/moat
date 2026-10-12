<?php

declare(strict_types=1);

namespace Moat\Gate\Runtime;

use Moat\Gate\Bundle\PinnedSigner;
use Moat\Gate\Encoding\Base64Url;
use Moat\Gate\Json\JsonObject;
use Moat\Gate\Json\StrictJson;

/**
 * The pinned trust anchors (docs/CRYPTO.md §8, `trust.json`): written only on the server, never
 * changeable through a bundle (SEC-06, SEC-13). Modes 0 and 1 pin Ed25519 signers; mode 2
 * (passkeys) is not built yet and is refused rather than weakened.
 */
final readonly class Trust
{
    /** @param list<PinnedSigner> $signers */
    public function __construct(
        public string $gateId,
        public int $mode,
        public int $threshold,
        public array $signers,
    ) {}

    public static function parse(string $bytes, string $gateId): self
    {
        $value = StrictJson::decode($bytes);
        if (
            !$value instanceof JsonObject
            || !$value->hasExactKeys('v', 'gateId', 'mode', 'threshold', 'signers', 'cloud')
            || $value->get('v') !== 1
            || $value->get('gateId') !== $gateId
            || $value->get('cloud') !== null
        ) {
            throw new NotConfigured();
        }
        $mode = $value->get('mode');
        $entries = $value->get('signers');
        $threshold = $value->get('threshold');
        if (($mode !== 0 && $mode !== 1) || !\is_array($entries) || $entries === [] || \count($entries) > 16 || !\is_int($threshold) || $threshold < 1 || $threshold > \count($entries)) {
            throw new NotConfigured();
        }
        $signers = [];
        foreach ($entries as $entry) {
            if (!$entry instanceof JsonObject || !$entry->hasExactKeys('kid', 'alg', 'pk') || $entry->get('alg') !== 'ed25519') {
                throw new NotConfigured();
            }
            $signer = new PinnedSigner(Base64Url::decodeLength($entry->get('pk'), SODIUM_CRYPTO_SIGN_PUBLICKEYBYTES));
            if ($signer->kid !== $entry->get('kid')) {
                throw new NotConfigured();
            }
            $signers[] = $signer;
        }

        return new self($gateId, $mode, $threshold, $signers);
    }

    public function encode(): string
    {
        $signers = array_map(
            static fn(PinnedSigner $signer): array => ['kid' => $signer->kid, 'alg' => 'ed25519', 'pk' => Base64Url::encode($signer->publicKey)],
            $this->signers,
        );

        return json_encode(
            ['v' => 1, 'gateId' => $this->gateId, 'mode' => $this->mode, 'threshold' => $this->threshold, 'signers' => $signers, 'cloud' => null],
            JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT,
        ) . "\n";
    }
}
