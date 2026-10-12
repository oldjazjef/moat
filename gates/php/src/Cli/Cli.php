<?php

declare(strict_types=1);

namespace Moat\Gate\Cli;

use Moat\Gate\Bundle\BundleVerifier;
use Moat\Gate\Bundle\PinnedSigner;
use Moat\Gate\Config\Limit;
use Moat\Gate\Crypto\KeyAlgorithm;
use Moat\Gate\Crypto\KeyId;
use Moat\Gate\Encoding\Base64Url;
use Moat\Gate\Hardening\External;
use Moat\Gate\Hardening\ExternalCheck;
use Moat\Gate\Hardening\Facts;
use Moat\Gate\Hardening\Hardening;
use Moat\Gate\Hardening\Level;
use Moat\Gate\Hardening\PolicyState;
use Moat\Gate\Hardening\WebFacts;
use Moat\Gate\Json\StrictJson;
use Moat\Gate\Policy\PolicyCheck;
use Moat\Gate\Rejection;
use Moat\Gate\Runtime\Gate;
use Moat\Gate\Runtime\Identity;
use Moat\Gate\Runtime\NotConfigured;
use Moat\Gate\Runtime\Trust;
use Moat\Gate\Storage\DataDir;
use Moat\Gate\Storage\Files;

/**
 * The gate's only management surface: the command line on its own server (SEC-40 — there is no
 * inbound management endpoint). Trust, policy and identity change only here (SEC-06, SEC-13).
 *
 *   php moat-gate.php install --signer=<public key> [--threshold=1]
 *   php moat-gate.php trust --signer=<public key>[,<public key>…] [--threshold=1]
 *   php moat-gate.php policy <policy.json>
 *   php moat-gate.php accept <bundle.json>
 *   php moat-gate.php status
 *   php moat-gate.php check [--url=https://<site>/<path>/moat-gate.php]
 */
final class Cli
{
    private const USAGE = "usage: php moat-gate.php install|trust|policy|accept|status|check (see the gate README)\n";

    /** @param list<string> $argv */
    public static function main(string $gateDir, array $argv): int
    {
        [$args, $options] = self::parse(\array_slice($argv, 1));
        $command = array_shift($args);
        try {
            return match ($command) {
                'install' => self::install($gateDir, $options),
                'trust' => self::trust($gateDir, $options),
                'policy' => self::policy($gateDir, $args),
                'accept' => self::accept($gateDir, $args),
                'status' => self::status($gateDir),
                'check' => self::check($gateDir, $args, $options),
                default => self::usage(self::USAGE),
            };
        } catch (Rejection $rejection) {
            fwrite(STDERR, 'rejected: ' . $rejection->reason->value . "\n");

            return 1;
        } catch (NotConfigured) {
            fwrite(STDERR, "the gate is not installed or its data files are invalid (run install)\n");

            return 1;
        } catch (UsageError $error) {
            return self::usage($error->getMessage() . "\n");
        }
    }

    /** @param array<string, string> $options */
    private static function install(string $gateDir, array $options): int
    {
        $signers = self::signers($options);
        if (DataDir::locate($gateDir) !== null) {
            throw new UsageError('this gate is already installed');
        }
        $data = DataDir::create($gateDir);
        $identity = Identity::generate();
        $data->write(Gate::IDENTITY, $identity->encode());
        $data->write(Gate::TRUST, (new Trust($identity->gateId, 1, self::threshold($options, \count($signers)), $signers))->encode());
        self::out('Installed. Data folder: ' . basename($data->path));
        self::describe($identity, $signers);
        self::out('');
        self::out('Next: compare the fingerprints, then in the project folder run');
        // `=` form: a base64url value may start with "-" and would read as an option.
        self::out('  moat gate add <name> --gate-id=' . $identity->gateId . ' --box-key=' . Base64Url::encode($identity->boxPublicKey));
        self::out('and install a local policy: php moat-gate.php policy <policy.json>');

        return 0;
    }

    /** @param array<string, string> $options */
    private static function trust(string $gateDir, array $options): int
    {
        $gate = Gate::open($gateDir);
        $signers = self::signers($options);
        $gate->data->write(Gate::TRUST, (new Trust($gate->identity->gateId, 1, self::threshold($options, \count($signers)), $signers))->encode());
        self::out('Pinned signers replaced. A bundle not signed by them is no longer served.');
        self::describe($gate->identity, $signers);

        return 0;
    }

    /** @param list<string> $args */
    private static function policy(string $gateDir, array $args): int
    {
        $gate = Gate::open($gateDir);
        $bytes = self::readArg($args, 'usage: php moat-gate.php policy <policy.json>');
        $policy = PolicyCheck::parse(StrictJson::decode($bytes));
        $gate->data->write(Gate::POLICY, $bytes);
        self::out('Local policy installed: ' . \count($policy->upstreams) . ' upstream host(s).');
        if ($policy->testing) {
            self::out('WARNING: the policy has a "testing" block (loopback upstreams, extra CA). Never use it with real secrets.');
        }

        return 0;
    }

    /** @param list<string> $args */
    private static function accept(string $gateDir, array $args): int
    {
        $gate = Gate::open($gateDir);
        $bytes = self::readArg($args, 'usage: php moat-gate.php accept <bundle.json>');
        $active = $gate->accept($bytes, time());
        self::out('Accepted bundle version ' . $active->version . ': ' . \count($active->config->routes) . ' route(s).');
        if (!$active->config->enabled) {
            self::out('LOCKED: the gate answers every request with gate_disabled and forwards nothing.');
        }
        foreach ($active->config->routes as $name => $route) {
            self::out(\sprintf('  %-6s %s → %s%s%s', $route->method->value, $route->path, $active->config->upstreamOf($route)->origin, $route->upstreamPath, $route->enabled ? '' : ' (disabled)'));
        }

        return 0;
    }

    private static function status(string $gateDir): int
    {
        $gate = Gate::open($gateDir);
        self::describe($gate->identity, $gate->trust === null ? [] : $gate->trust->signers);
        self::out('Policy:     ' . ($gate->policy === null ? 'missing — the gate serves nothing' : 'installed' . ($gate->policy->testing ? ' (TESTING block present)' : '')));
        if ($gate->policy !== null) {
            $limits = $gate->policy->limits;
            self::out('Limits:     ' . self::limitText($limits->perIp) . ' per IP, ' . self::limitText($limits->total) . ' in total, at most ' . $limits->maxClients . ' clients tracked');
            if ($limits->quota !== null) {
                self::out('Quota:      ' . $limits->quota->requests . ' requests per ' . $limits->quota->period->value . ' (UTC) for the whole gate');
            }
        }
        try {
            $active = $gate->active(time());
            self::out('Bundle:     version ' . $active->version . ', ' . \count($active->config->routes) . ' route(s)' . ($active->config->enabled ? '' : ', LOCKED (every request is refused with gate_disabled)'));
        } catch (NotConfigured) {
            self::out('Bundle:     none active (missing, or no longer valid for the current trust and policy)');
        }

        return 0;
    }

    /**
     * The hardening check (SEC-49, SEC-49a): the web process's recorded facts, the data folder's
     * permissions, the policy and, with --url, a fetch of the data files from outside. Exit code
     * 0 for H1, 1 when the gate is unsafe for secrets, 3 when no level could be determined.
     *
     * @param list<string>          $args
     * @param array<string, string> $options
     */
    private static function check(string $gateDir, array $args, array $options): int
    {
        if ($args !== [] || array_diff(array_keys($options), ['url']) !== []) {
            throw new UsageError('usage: php moat-gate.php check [--url=https://<site>/<path>/moat-gate.php]');
        }
        $gate = Gate::open($gateDir);
        $external = External::NotChecked;
        if (isset($options['url'])) {
            try {
                // Also a request to the gate, so its web process records its facts first.
                $external = ExternalCheck::run($options['url'], $gate->data, $gate->policy);
            } catch (\InvalidArgumentException $error) {
                throw new UsageError($error->getMessage());
            }
        }
        $web = WebFacts::read($gate->data);
        $policy = match (true) {
            $gate->policy === null => PolicyState::Missing,
            $gate->policy->testing => PolicyState::Testing,
            default => PolicyState::Installed,
        };
        $now = time();
        $report = Hardening::classify(new Facts($now, $web, $gate->data->permissionsOpen(), $policy, $external));

        self::out('Web process:  ' . ($web === null ? 'not seen yet (no request has reached the gate)' : self::webText($web)));
        self::out('Data folder:  ' . basename($gate->data->path) . ', permissions ' . ($gate->data->permissionsOpen() ? 'open to group or others' : 'owner only'));
        self::out('Policy:       ' . $policy->value);
        self::out('From outside: ' . match ($external) {
            External::NotChecked => 'not checked (pass --url)',
            External::Failed => 'failed: the gate could not be reached',
            External::NotGate => 'the URL does not reach this gate',
            External::Blocked => 'blocked: no data file or folder listing came back',
            External::Reachable => 'REACHABLE: data files can be fetched from the internet',
        });
        self::out('Level:        ' . ($report->level === null ? 'not determined (see below)' : $report->level->label()));
        self::out('');
        foreach ($report->findings as $finding) {
            self::out(\sprintf('  %-7s %s', $finding->severity(), $finding->value));
            self::out('          ' . $finding->advice());
        }

        return match ($report->level) {
            Level::H1 => 0,
            Level::Unsafe => 1,
            null => 3,
        };
    }

    private static function webText(WebFacts $web): string
    {
        $owner = match ($web->ownsFiles) {
            true => 'owns the gate file',
            false => 'does not own the gate file',
            null => 'owner unknown',
        };

        return 'user ' . ($web->user ?? 'unknown') . ($web->uid === null ? '' : ' (uid ' . $web->uid . ')') . ', ' . $owner
            . ', open_basedir ' . ($web->openBasedir ? 'set' : 'not set')
            . ', SAPI ' . $web->sapi . ', seen ' . gmdate('Y-m-d H:i', $web->at) . ' UTC';
    }

    private static function limitText(Limit $limit): string
    {
        return $limit->requests . ' requests / ' . $limit->windowSeconds . ' s';
    }

    /** @param list<PinnedSigner> $signers */
    private static function describe(Identity $identity, array $signers): void
    {
        self::out('Gate id:    ' . $identity->gateId);
        self::out('Box key:    ' . KeyId::fingerprint(KeyAlgorithm::X25519, $identity->boxPublicKey));
        foreach ($signers as $signer) {
            self::out('Signer:     ' . KeyId::fingerprint(KeyAlgorithm::Ed25519, $signer->publicKey));
        }
    }

    /**
     * @param array<string, string> $options
     *
     * @return list<PinnedSigner>
     */
    private static function signers(array $options): array
    {
        $signers = [];
        foreach (explode(',', $options['signer'] ?? '') as $key) {
            try {
                $signers[] = new PinnedSigner(Base64Url::decodeLength($key, SODIUM_CRYPTO_SIGN_PUBLICKEYBYTES));
            } catch (Rejection) {
                throw new UsageError('--signer needs the 32-byte public key(s) that `moat keygen` printed');
            }
        }

        return $signers;
    }

    /** @param array<string, string> $options */
    private static function threshold(array $options, int $signers): int
    {
        $threshold = $options['threshold'] ?? '1';
        if (preg_match('/^[1-9][0-9]?$/D', $threshold) !== 1 || (int) $threshold > $signers) {
            throw new UsageError('--threshold must be between 1 and the number of signers');
        }

        return (int) $threshold;
    }

    /** @param list<string> $args */
    private static function readArg(array $args, string $usage): string
    {
        if (\count($args) !== 1) {
            throw new UsageError($usage);
        }
        $bytes = Files::read($args[0], BundleVerifier::MAX_ENVELOPE_BYTES);
        if ($bytes === null) {
            throw new UsageError('cannot read ' . $args[0]);
        }

        return $bytes;
    }

    /**
     * @param list<string> $argv
     *
     * @return array{list<string>, array<string, string>}
     */
    private static function parse(array $argv): array
    {
        $args = [];
        $options = [];
        foreach ($argv as $arg) {
            if (preg_match('/^--([a-z]+)=(.*)$/sD', $arg, $match) === 1) {
                $options[$match[1]] = $match[2];
            } else {
                $args[] = $arg;
            }
        }

        return [$args, $options];
    }

    private static function out(string $line): void
    {
        fwrite(STDOUT, $line . "\n");
    }

    private static function usage(string $message): int
    {
        fwrite(STDERR, $message);

        return 2;
    }
}
