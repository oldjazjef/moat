<?php

declare(strict_types=1);

namespace Moat\Gate\Runtime;

use Moat\Gate\Bundle\BundleVerifier;
use Moat\Gate\Bundle\VerificationContext;
use Moat\Gate\Bundle\VerifiedBundle;
use Moat\Gate\Config\ConfigValidator;
use Moat\Gate\Json\JsonObject;
use Moat\Gate\Json\StrictJson;
use Moat\Gate\Policy\Policy;
use Moat\Gate\Policy\PolicyCheck;
use Moat\Gate\Rejection;
use Moat\Gate\RejectionCode;
use Moat\Gate\Secret\SecretOpener;
use Moat\Gate\Storage\DataDir;

/**
 * Everything the gate knows, read from its data folder: identity, pinned trust, local policy and
 * the active bundle. The active bundle is verified again on every load (signature, gate id,
 * schema and the policy as it is *now*), so narrowing the policy or replacing trust.json on the
 * server takes effect at once, and a bundle that no longer fits is not served (SEC-11, SEC-46).
 */
final readonly class Gate
{
    public const IDENTITY = 'identity';
    public const TRUST = 'trust';
    public const POLICY = 'policy';
    public const BUNDLE = 'bundle';
    public const STATE = 'state';

    private function __construct(
        public DataDir $data,
        public Identity $identity,
        public ?Trust $trust,
        public ?Policy $policy,
    ) {}

    /** @throws NotConfigured when the gate is not installed */
    public static function open(string $gateDir): self
    {
        $data = DataDir::locate($gateDir) ?? throw new NotConfigured();
        try {
            $identity = Identity::parse($data->read(self::IDENTITY) ?? throw new NotConfigured());
            $trust = $data->read(self::TRUST);
            $policy = $data->read(self::POLICY);

            return new self(
                $data,
                $identity,
                $trust === null ? null : Trust::parse($trust, $identity->gateId),
                $policy === null ? null : PolicyCheck::parse(StrictJson::decode($policy)),
            );
        } catch (Rejection | \RuntimeException) {
            throw new NotConfigured();
        }
    }

    /** The active bundle for serving requests; throws NotConfigured if anything is missing or no longer valid. */
    public function active(int $now): ActiveBundle
    {
        $bytes = $this->data->read(self::BUNDLE);
        if ($bytes === null || $this->trust === null || $this->policy === null) {
            throw new NotConfigured();
        }
        try {
            return $this->check(BundleVerifier::verify($bytes, $this->context(0, $now)), false);
        } catch (Rejection) {
            throw new NotConfigured();
        }
    }

    /**
     * Steps 1–10 of docs/CRYPTO.md §4.3 for a new bundle: verify, check schema and policy, open
     * every secret once (a secret sealed for another gate fails now, not on the first request),
     * then store bytes and version atomically. Throws Rejection with the failing check.
     */
    public function accept(string $bytes, int $now): ActiveBundle
    {
        if ($this->trust === null) {
            throw new NotConfigured();
        }
        if ($this->policy === null) {
            throw new Rejection(RejectionCode::PolicyInvalid);
        }
        // Under the lock the pull also takes: `accept` on the command line and a pull from a
        // visitor's request never both pass the version check before either has written (SEC-04).
        $active = $this->data->locked(function () use ($bytes, $now): ActiveBundle {
            $active = $this->check(BundleVerifier::verify($bytes, $this->context($this->highestVersion(), $now)), true);
            $this->data->write(self::BUNDLE, $bytes);
            $this->data->write(self::STATE, json_encode(['v' => 1, 'highestVersion' => $active->version], JSON_THROW_ON_ERROR) . "\n");

            return $active;
        }, BundlePull::LOCK);

        return $active;
    }

    /** The highest version ever accepted — a deleted bundle file does not reopen a rollback (SEC-04). */
    public function highestVersion(): int
    {
        $highest = 0;
        $state = $this->data->read(self::STATE);
        if ($state !== null) {
            $value = StrictJson::decode($state);
            $recorded = $value instanceof JsonObject ? $value->get('highestVersion') : null;
            $highest = \is_int($recorded) ? $recorded : 0;
        }
        $bundle = $this->data->read(self::BUNDLE);
        if ($bundle !== null && $this->trust !== null) {
            try {
                $highest = max($highest, BundleVerifier::verify($bundle, $this->context(0, 0))->version);
            } catch (Rejection) {
                // A broken active bundle does not lower the high-water mark.
            }
        }

        return $highest;
    }

    private function context(int $currentVersion, int $now): VerificationContext
    {
        $trust = $this->trust ?? throw new NotConfigured();

        return new VerificationContext($this->identity->gateId, $trust->signers, $trust->threshold, $currentVersion, $now, false);
    }

    private function check(VerifiedBundle $bundle, bool $openSecrets): ActiveBundle
    {
        $policy = $this->policy ?? throw new NotConfigured();
        // 9. Schema, then the local policy (SEC-11, SEC-14).
        $config = ConfigValidator::validate($bundle->config, $bundle->secrets->keys());
        PolicyCheck::check($config, $policy);
        if ($openSecrets) {
            foreach ($bundle->secrets->keys() as $name) {
                $plaintext = SecretOpener::open($bundle->secrets->get($name), $this->identity->boxSecretKey, $this->identity->gateId, $name);
                sodium_memzero($plaintext);
            }
        }

        return new ActiveBundle($bundle->version, $config, $bundle->secrets, $policy, $bundle->issuedAt);
    }

    /** Opens one secret for one upstream call; the caller wipes it (SEC-35). */
    public function openSecret(ActiveBundle $bundle, string $name): string
    {
        return SecretOpener::open($bundle->secrets->get($name), $this->identity->boxSecretKey, $this->identity->gateId, $name);
    }
}
