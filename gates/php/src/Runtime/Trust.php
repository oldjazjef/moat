<?php

declare(strict_types=1);

namespace Moat\Gate\Runtime;

use Moat\Gate\Bundle\PinnedPasskey;
use Moat\Gate\Bundle\PinnedSigner;
use Moat\Gate\Crypto\Es256;
use Moat\Gate\Crypto\KeyAlgorithm;
use Moat\Gate\Encoding\Base64Url;
use Moat\Gate\Json\JsonObject;
use Moat\Gate\Json\StrictJson;

/**
 * The pinned trust anchors (docs/CRYPTO.md §8, `trust.json`): written only on the server, never
 * changeable through a bundle (SEC-06, SEC-13). Modes 0 and 1 pin Ed25519 signers, mode 2
 * (passkeys, docs/CRYPTO.md §7) pins WebAuthn ES256 keys with their rpId and origins. The mode
 * says which kind: a file that mixes them is invalid, never half-used.
 */
final readonly class Trust
{
    /** @param list<PinnedSigner|PinnedPasskey> $signers */
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
        if (($mode !== 0 && $mode !== 1 && $mode !== 2) || !\is_array($entries) || $entries === [] || \count($entries) > 16 || !\is_int($threshold) || $threshold < 1 || $threshold > \count($entries)) {
            throw new NotConfigured();
        }
        $signers = [];
        try {
            foreach ($entries as $entry) {
                $signer = $mode === 2 ? self::passkey($entry) : self::ed25519($entry);
                foreach ($signers as $known) {
                    if ($known->kid === $signer->kid) {
                        throw new NotConfigured();
                    }
                }
                $signers[] = $signer;
            }
        } catch (\InvalidArgumentException) {
            throw new NotConfigured();
        }

        return new self($gateId, $mode, $threshold, $signers);
    }

    /** True in mode 2: the signatures are ECDSA and need `ext-openssl` (docs/CRYPTO.md §7.4). */
    public function needsOpenssl(): bool
    {
        return $this->mode === 2;
    }

    /**
     * The extension this trust needs and the PHP lacks, or null. `$loaded` is `extension_loaded`
     * unless a test says otherwise.
     */
    public function missingExtension(?\Closure $loaded = null): ?string
    {
        $loaded ??= \extension_loaded(...);

        return $this->needsOpenssl() && $loaded('openssl') !== true ? 'openssl' : null;
    }

    private static function ed25519(mixed $entry): PinnedSigner
    {
        if (!$entry instanceof JsonObject || !$entry->hasExactKeys('kid', 'alg', 'pk') || $entry->get('alg') !== KeyAlgorithm::Ed25519->value) {
            throw new NotConfigured();
        }
        $signer = new PinnedSigner(Base64Url::decodeLength($entry->get('pk'), SODIUM_CRYPTO_SIGN_PUBLICKEYBYTES));
        if ($signer->kid !== $entry->get('kid')) {
            throw new NotConfigured();
        }

        return $signer;
    }

    private static function passkey(mixed $entry): PinnedPasskey
    {
        if (!$entry instanceof JsonObject || !$entry->hasExactKeys('kid', 'alg', 'pk', 'rpId', 'origins') || $entry->get('alg') !== KeyAlgorithm::WebAuthnEs256->value) {
            throw new NotConfigured();
        }
        $rpId = $entry->get('rpId');
        $origins = $entry->get('origins');
        if (!\is_string($rpId) || !\is_array($origins)) {
            throw new NotConfigured();
        }
        $list = [];
        foreach ($origins as $origin) {
            if (!\is_string($origin)) {
                throw new NotConfigured();
            }
            $list[] = $origin;
        }
        $signer = new PinnedPasskey(Base64Url::decodeLength($entry->get('pk'), Es256::POINT_BYTES), $rpId, $list);
        if ($signer->kid !== $entry->get('kid')) {
            throw new NotConfigured();
        }

        return $signer;
    }

    public function encode(): string
    {
        $signers = array_map(
            static fn(PinnedSigner|PinnedPasskey $signer): array => $signer instanceof PinnedPasskey
                ? ['kid' => $signer->kid, 'alg' => $signer->alg->value, 'pk' => Base64Url::encode($signer->publicKey), 'rpId' => $signer->rpId, 'origins' => $signer->origins]
                : ['kid' => $signer->kid, 'alg' => $signer->alg->value, 'pk' => Base64Url::encode($signer->publicKey)],
            $this->signers,
        );

        return json_encode(
            ['v' => 1, 'gateId' => $this->gateId, 'mode' => $this->mode, 'threshold' => $this->threshold, 'signers' => $signers, 'cloud' => null],
            JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT,
        ) . "\n";
    }
}
