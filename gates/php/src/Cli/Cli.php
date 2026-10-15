<?php

declare(strict_types=1);

namespace Moat\Gate\Cli;

use Moat\Gate\Bundle\BundleVerifier;
use Moat\Gate\Bundle\PinnedPasskey;
use Moat\Gate\Bundle\PinnedSigner;
use Moat\Gate\Config\Budget;
use Moat\Gate\Config\Limit;
use Moat\Gate\Crypto\Es256;
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
use Moat\Gate\Runtime\BudgetStore;
use Moat\Gate\Runtime\BundlePull;
use Moat\Gate\Runtime\Gate;
use Moat\Gate\Runtime\Identity;
use Moat\Gate\Runtime\KillSwitch;
use Moat\Gate\Runtime\NotConfigured;
use Moat\Gate\Runtime\PullOutcome;
use Moat\Gate\Runtime\PullRecord;
use Moat\Gate\Runtime\RequestLog;
use Moat\Gate\Runtime\SetupMode;
use Moat\Gate\Runtime\Trust;
use Moat\Gate\Storage\DataDir;
use Moat\Gate\Storage\Files;

/**
 * The gate's only management surface: the command line on its own server (SEC-40 — there is no
 * inbound management endpoint). Trust, policy and identity change only here (SEC-06, SEC-13).
 *
 *   php moat-gate.php install --signer=<public key> [--threshold=1]
 *   php moat-gate.php install --passkey=<point> --rp-id=<rpId> --origin=<origin>[,…] [--threshold=1]
 *   php moat-gate.php trust --signer=<public key>[,<public key>…] [--threshold=1] [--force]
 *   php moat-gate.php trust --passkey=<point>[,<point>…] --rp-id=<rpId> --origin=<origin>[,<origin>…] [--threshold=1] [--force]
 *   php moat-gate.php policy <policy.json>
 *   php moat-gate.php accept <bundle.json>
 *   php moat-gate.php pull
 *   php moat-gate.php status
 *   php moat-gate.php kill [--route=<name>]
 *   php moat-gate.php revive [--route=<name>]
 *   php moat-gate.php check [--url=https://<site>/<path>/moat-gate.php]
 *   php moat-gate.php log [--lines=<n>]
 *   php moat-gate.php setup
 */
final class Cli
{
    private const USAGE = "usage: php moat-gate.php install|trust|policy|accept|pull|status|check|kill|revive|log|setup (see the gate README)\n";

    /** @param list<string> $argv */
    public static function main(string $gateDir, array $argv): int
    {
        [$args, $options] = self::parse(\array_slice($argv, 1));
        $command = array_shift($args);
        try {
            return match ($command) {
                'install' => self::install($gateDir, $options),
                'trust' => self::trust($gateDir, $args, $options),
                'policy' => self::policy($gateDir, $args),
                'accept' => self::accept($gateDir, $args),
                'pull' => self::pull($gateDir),
                'status' => self::status($gateDir),
                'check' => self::check($gateDir, $args, $options),
                'kill' => self::kill($gateDir, $args, $options, true),
                'revive' => self::kill($gateDir, $args, $options, false),
                'log' => self::log($gateDir, $args, $options),
                'setup' => self::setup($gateDir, $args, $options),
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
        } catch (\RuntimeException $error) {
            fwrite(STDERR, 'failed: ' . $error->getMessage() . "\n");

            return 1;
        }
    }

    /** @param array<string, string> $options */
    private static function install(string $gateDir, array $options): int
    {
        // The gate id exists only after install creates it; the keys are checked first so that a
        // wrong key leaves nothing behind.
        self::pins($options);
        if (DataDir::locate($gateDir) !== null) {
            throw new UsageError('this gate is already installed');
        }
        $data = DataDir::create($gateDir);
        $identity = Identity::generate();
        $trust = self::trustFrom($identity->gateId, $options);
        $data->write(Gate::IDENTITY, $identity->encode());
        $data->write(Gate::TRUST, $trust->encode());
        self::out('Installed. Data folder: ' . basename($data->path));
        self::describe($identity, $trust);
        self::out('');
        self::out('Next: compare the fingerprints, then in the project folder run');
        // `=` form: a base64url value may start with "-" and would read as an option.
        self::out('  moat gate add <name> --gate-id=' . $identity->gateId . ' --box-key=' . Base64Url::encode($identity->boxPublicKey));
        self::out('and install a local policy: php moat-gate.php policy <policy.json>');
        self::setupText(SetupMode::enable(Gate::open($gateDir), time()));

        return 0;
    }

    /**
     * SEC-28: switches the setup mode on again (30 minutes, until a newer bundle arrives) and
     * prints the new token once. Only here, on the server's command line.
     *
     * @param list<string>          $args
     * @param array<string, string> $options
     */
    private static function setup(string $gateDir, array $args, array $options): int
    {
        if ($args !== [] || $options !== []) {
            throw new UsageError('usage: php moat-gate.php setup');
        }
        self::setupText(SetupMode::enable(Gate::open($gateDir), time()));

        return 0;
    }

    private static function setupText(string $token): void
    {
        self::out('');
        self::out('Setup mode is on for ' . intdiv(SetupMode::LIFETIME_SECONDS, 60) . ' minutes and until the next bundle is accepted.');
        self::out('Moat Desktop reads the fingerprints from https://<site>/<path>/moat-gate.php?' . SetupMode::QUERY);
        self::out('with this token (shown only now): ' . $token);
    }

    /**
     * @param list<string>          $args
     * @param array<string, string> $options
     */
    private static function trust(string $gateDir, array $args, array $options): int
    {
        $usage = 'usage: php moat-gate.php trust --signer=<public key>[,<public key>…] | --passkey=<point>[,…] --rp-id=<rpId> --origin=<origin>[,…] [--threshold=n] [--force]';
        $force = $args === ['--force'];
        if ($args !== [] && !$force) {
            throw new UsageError($usage);
        }
        $gate = Gate::open($gateDir);
        $next = self::trustFrom($gate->identity->gateId, $options);
        $before = $gate->data->read(Gate::TRUST);
        $served = self::serves($gateDir);
        $gate->data->write(Gate::TRUST, $next->encode());
        // SEC-08: a rotation pins the old and the new key until a bundle signed with the new one
        // is active. Dropping the key of the active bundle stops the site; only with --force.
        // A change of the mode is the same case: the keys of the other mode do not count.
        if ($served && !self::serves($gateDir) && !$force) {
            if ($before !== null) {
                $gate->data->write(Gate::TRUST, $before);
            }
            $changed = $gate->trust !== null && $gate->trust->mode !== $next->mode;
            fwrite(STDERR, "refused: the active bundle is not signed by these signers, so the gate would serve nothing.\n"
                . ($changed
                    ? "A change between trust modes pins keys of another algorithm, so the active bundle cannot be verified. Add --force, then accept a bundle signed in the new mode (SEC-06).\n"
                    : "Rotate in two steps: pin the old and the new key (--signer=<old>,<new>), activate a bundle signed with the new key, then pin the new key alone.\nTo stop serving the active bundle anyway, add --force.\n"));

            return 1;
        }
        self::out($next->mode === 2 ? 'Pinned passkeys replaced (trust mode 2). A bundle not signed by them is no longer served.' : 'Pinned signers replaced. A bundle not signed by them is no longer served.');
        self::describe($gate->identity, $next);

        return 0;
    }

    /** True when the gate has an active bundle it would serve right now. */
    private static function serves(string $gateDir): bool
    {
        try {
            Gate::open($gateDir)->active(time());

            return true;
        } catch (NotConfigured) {
            return false;
        }
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
        self::requireExtensions($gate);
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

    /** The lazy pull (DT-11) right now, whatever the interval says, with what came of it. */
    private static function pull(string $gateDir): int
    {
        $gate = Gate::open($gateDir);
        if ($gate->policy?->pull === null) {
            throw new UsageError('the local policy has no "pull" block: nothing to pull from');
        }
        self::requireExtensions($gate);
        $record = BundlePull::now($gate, time()) ?? throw new \RuntimeException('no pull');
        self::out('Pulled ' . $gate->policy->pull->url() . ': ' . self::pullText($record));

        return $record->outcome === PullOutcome::Accepted || $record->outcome === PullOutcome::Unchanged ? 0 : 1;
    }

    private static function pullText(PullRecord $record): string
    {
        return match ($record->outcome) {
            PullOutcome::Accepted => 'accepted version ' . $record->version . '.',
            PullOutcome::Unchanged => 'unchanged, the active bundle is the same file.',
            PullOutcome::Rejected => 'rejected (' . $record->reason . '), the active bundle stays.',
            PullOutcome::HttpStatus => 'the place answered ' . $record->reason . ', the active bundle stays.',
            PullOutcome::Failed => 'no usable answer (' . $record->reason . '), the active bundle stays.',
            null => 'still running or interrupted.',
        };
    }

    /**
     * The request log (FR-50, DT-12): the newest lines of `logold` and `log`, oldest first, one
     * JSON object per line — what Moat Desktop reads («Log ansehen»). Never a path, query, body
     * or address: the gate does not write them.
     *
     * @param list<string>          $args
     * @param array<string, string> $options
     */
    private static function log(string $gateDir, array $args, array $options): int
    {
        $data = DataDir::locate($gateDir) ?? throw new NotConfigured();
        $lines = $options['lines'] ?? '1000';
        unset($options['lines']);
        if ($args !== [] || $options !== [] || preg_match('/^[1-9][0-9]{0,4}$/D', $lines) !== 1) {
            throw new UsageError('usage: php moat-gate.php log [--lines=<1 to 99999>]');
        }
        foreach (RequestLog::lines($data, (int) $lines) as $line) {
            self::out($line);
        }

        return 0;
    }

    /**
     * The local kill switch (SEC-15): `kill` switches the whole gate or one route off, `revive`
     * on again (without --route: everything). Works on the data folder alone, so it also works
     * when the gate's other data files are missing or invalid.
     *
     * @param list<string>          $args
     * @param array<string, string> $options
     */
    private static function kill(string $gateDir, array $args, array $options, bool $kill): int
    {
        $data = DataDir::locate($gateDir) ?? throw new NotConfigured();
        $route = $options['route'] ?? null;
        unset($options['route']);
        // `revive chat` or `kill --route chat` must not quietly mean "everything".
        if ($args !== [] || $options !== [] || ($route !== null && !KillSwitch::validRouteName($route))) {
            throw new UsageError('usage: php moat-gate.php ' . ($kill ? 'kill' : 'revive') . ' [--route=<name>]');
        }
        // Its own lock: the request lock can be busy under exactly the load the switch is for.
        $switch = $data->locked(static function () use ($data, $route, $kill): KillSwitch {
            $switch = KillSwitch::read($data);
            if ($kill) {
                $switch = $route === null ? $switch->killGate() : $switch->killRoute($route);
            } elseif ($route === null) {
                $switch = KillSwitch::parse('');
            } else {
                $switch = $switch->reviveRoute($route);
            }
            if ($switch->isOff()) {
                $data->remove(KillSwitch::FILE);
            } else {
                $data->write(KillSwitch::FILE, $switch->text());
            }

            return $switch;
        }, KillSwitch::LOCK);
        self::out(self::killText($switch));
        $owner = $data->owner(KillSwitch::FILE);
        if ($owner !== null && $owner !== $data->owner(Gate::IDENTITY)) {
            self::out('WARNING: kill.php belongs to another user than the gate\'s other data files. If the web server cannot read it, the whole gate stays off; run the command as the site\'s user.');
        }
        if ($kill && $route !== null) {
            try {
                if (!isset(Gate::open($gateDir)->active(time())->config->routes[$route])) {
                    self::out('Note: the active bundle has no route "' . $route . '"; it is switched off as soon as one has it.');
                }
            } catch (\Throwable) {
                // No usable active bundle to compare with: the switch is written all the same.
            }
        }

        return 0;
    }

    private static function killText(KillSwitch $switch): string
    {
        if ($switch->gate) {
            return 'Kill switch: the whole gate is OFF (every request gets gate_disabled). php moat-gate.php revive switches it on again.';
        }
        if ($switch->routes !== []) {
            return 'Kill switch: route(s) OFF: ' . implode(', ', $switch->routes) . ' (route_disabled).';
        }

        return 'Kill switch: nothing switched off.';
    }

    private static function status(string $gateDir): int
    {
        $gate = Gate::open($gateDir);
        self::describe($gate->identity, $gate->trust);
        self::out('Policy:     ' . ($gate->policy === null ? 'missing — the gate serves nothing' : 'installed' . ($gate->policy->testing ? ' (TESTING block present)' : '')));
        if ($gate->policy !== null) {
            $limits = $gate->policy->limits;
            self::out('Limits:     ' . self::limitText($limits->perIp) . ' per IP, ' . self::limitText($limits->total) . ' in total, at most ' . $limits->maxClients . ' clients tracked');
            if ($limits->quota !== null) {
                self::out('Quota:      ' . $limits->quota->requests . ' requests per ' . $limits->quota->period->value . ' (UTC) for the whole gate');
            }
            foreach ($gate->policy->upstreams as $hostKey => $upstream) {
                if ($upstream->budget !== null) {
                    self::out('Budget:     ' . $hostKey . ' (policy): ' . self::budgetText($gate, BudgetStore::hostName($hostKey, $upstream->budget), $upstream->budget));
                }
            }
        }
        $routeNames = null;
        try {
            $active = $gate->active(time());
            $routeNames = array_keys($active->config->routes);
            self::out('Bundle:     version ' . $active->version . ', ' . \count($active->config->routes) . ' route(s), signed ' . gmdate('Y-m-d H:i', $active->issuedAt) . ' UTC' . ($active->config->enabled ? '' : ', LOCKED (every request is refused with gate_disabled)'));
            $maxAge = $active->policy->maxConfigAgeSeconds;
            if ($maxAge !== null && time() - $active->issuedAt > $maxAge) {
                self::out('WARNING:    the active config is older than the policy allows (' . intdiv(time() - $active->issuedAt, 86_400) . ' days). A lock may not have arrived: use php moat-gate.php kill if needed (T-23).');
            }
            foreach ($active->config->routes as $name => $route) {
                if ($route->budget !== null) {
                    self::out('Budget:     route ' . $name . ': ' . self::budgetText($gate, BudgetStore::routeName($name, $route->budget), $route->budget));
                }
            }
        } catch (NotConfigured) {
            self::out('Bundle:     none active (missing, or no longer valid for the current trust and policy)');
        }
        if ($gate->policy?->pull !== null) {
            $record = PullRecord::read($gate->data);
            self::out('Pull:       ' . $gate->policy->pull->url() . ' at most every ' . $gate->policy->pull->intervalSeconds . ' s; '
                . ($record === null ? 'not tried yet' : 'last ' . gmdate('Y-m-d H:i', $record->attemptedAt) . ' UTC, ' . self::pullText($record)));
        }
        $setup = SetupMode::remaining($gate, time());
        self::out('Setup mode: ' . ($setup === null ? 'off (php moat-gate.php setup switches it on)' : 'on for ' . intdiv($setup + 59, 60) . ' more minute(s)'));
        $switch = KillSwitch::read($gate->data);
        self::out(self::killText($switch));
        foreach ($routeNames === null ? [] : array_diff($switch->routes, $routeNames) as $missing) {
            // A route kill holds by name: a bundle that renames the route is not stopped (T-23).
            self::out('WARNING:    the killed route "' . $missing . '" is not in the active bundle. If the config is not to be trusted, kill the whole gate: php moat-gate.php kill');
        }

        return 0;
    }

    /** What a budget (FR-31) has spent in its current period, e.g. `1200 of 100000 tokens, 0.42 of 20.00 per day (UTC)`. */
    private static function budgetText(Gate $gate, string $name, Budget $budget): string
    {
        try {
            $spent = BudgetStore::spent($gate->data, $name, time());
        } catch (\RuntimeException) {
            return 'store damaged — every request with a budget is refused';
        }
        $parts = [];
        if ($budget->tokens !== null) {
            $parts[] = ($spent[0] ?? 0) . ' of ' . $budget->tokens . ' tokens';
        }
        if ($budget->cost !== null) {
            $parts[] = self::microsText($spent[1] ?? 0) . ' of ' . self::microsText($budget->cost->limitMicros);
        }

        return implode(', ', $parts) . ' per ' . $budget->period->value . ' (UTC)' . ($spent === null ? '' : ', resets ' . gmdate('Y-m-d H:i', $spent[2]) . ' UTC');
    }

    /** Micros as a decimal amount with at least two places: 420000 → "0.42". */
    private static function microsText(int $micros): string
    {
        $fraction = rtrim(str_pad((string) ($micros % Budget::MICROS), 6, '0', STR_PAD_LEFT), '0');

        return intdiv($micros, Budget::MICROS) . '.' . str_pad($fraction, 2, '0');
    }

    /**
     * The hardening check (SEC-49, SEC-49a): the web process's recorded facts, the data folder's
     * permissions, the policy and, with --url, a fetch of the data files from outside. Exit code
     * 0 for H1, 1 when the gate is unsafe for secrets or unusable (mode 2 without ext-openssl), 3 when
     * no level could be determined.
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
        $missing = $gate->trust?->missingExtension();
        if ($missing !== null) {
            self::out('Extension:     ' . $missing . ' MISSING — trust mode 2 verifies passkeys with it, so the gate refuses service until it is enabled (docs/CRYPTO.md §7.4)');
        }
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

        if ($missing !== null) {
            return 1;
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

    private static function describe(Identity $identity, ?Trust $trust): void
    {
        self::out('Gate id:    ' . $identity->gateId);
        self::out('Box key:    ' . KeyId::fingerprint(KeyAlgorithm::X25519, $identity->boxPublicKey));
        if ($trust === null) {
            return;
        }
        self::out('Trust mode: ' . match ($trust->mode) {
            0 => '0 (convenient)',
            1 => '1 (signed)',
            default => '2 (signed with passkey)',
        } . ($trust->threshold > 1 ? ', ' . $trust->threshold . ' of ' . \count($trust->signers) . ' signatures' : ''));
        foreach ($trust->signers as $signer) {
            if ($signer instanceof PinnedPasskey) {
                self::out('Passkey:    ' . KeyId::fingerprint($signer->alg, $signer->publicKey) . ' (rpId ' . $signer->rpId . ', origins ' . implode(' ', $signer->origins) . ')');
            } else {
                self::out('Signer:     ' . KeyId::fingerprint($signer->alg, $signer->publicKey));
            }
        }
        $missing = $trust->missingExtension();
        if ($missing !== null) {
            self::out('WARNING:    PHP extension ' . $missing . ' is MISSING. Trust mode 2 cannot verify a passkey signature without it: the gate refuses service until it is enabled (docs/CRYPTO.md §7.4).');
        }
    }

    /** Modes 0/1 refuse nothing here; mode 2 without ext-openssl cannot verify (docs/CRYPTO.md §7.4). */
    private static function requireExtensions(Gate $gate): void
    {
        $missing = $gate->trust?->missingExtension();
        if ($missing !== null) {
            throw new \RuntimeException('trust mode 2 needs the PHP extension ' . $missing);
        }
    }

    /**
     * The trust a command line pins: `--signer` is mode 1 (Ed25519), `--passkey` with `--rp-id`
     * and `--origin` is mode 2 (docs/CRYPTO.md §7.1); never both, the mode says which algorithm.
     *
     * @param array<string, string> $options
     */
    private static function trustFrom(string $gateId, array $options): Trust
    {
        [$mode, $signers, $threshold] = self::pins($options);

        return new Trust($gateId, $mode, $threshold, $signers);
    }

    /**
     * @param array<string, string> $options
     *
     * @return array{int, list<PinnedSigner|PinnedPasskey>, int} mode, keys, threshold
     */
    private static function pins(array $options): array
    {
        $passkeys = isset($options['passkey']);
        if ($passkeys && isset($options['signer'])) {
            throw new UsageError('--signer (mode 1) and --passkey (mode 2) cannot be combined: the mode decides which algorithm is pinned');
        }
        if (!$passkeys && (isset($options['rp-id']) || isset($options['origin']))) {
            throw new UsageError('--rp-id and --origin belong to --passkey');
        }
        $signers = $passkeys ? self::passkeys($options) : self::signers($options);
        for ($index = 1; $index < \count($signers); $index++) {
            foreach (\array_slice($signers, 0, $index) as $known) {
                if ($known->kid === $signers[$index]->kid) {
                    throw new UsageError('the same key is listed twice');
                }
            }
        }

        return [$passkeys ? 2 : 1, $signers, self::threshold($options, \count($signers))];
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

    /**
     * `--passkey=<point>[,<point>…] --rp-id=<rpId> --origin=<origin>[,<origin>…]`: every listed
     * passkey is pinned with the same rpId and origins. The points are base64url of the 65-byte
     * uncompressed P-256 key; they must lie on the curve, which needs ext-openssl.
     *
     * @param array<string, string> $options
     *
     * @return list<PinnedPasskey>
     */
    private static function passkeys(array $options): array
    {
        if (!isset($options['rp-id'], $options['origin'])) {
            throw new UsageError('--passkey needs --rp-id=<rpId> and --origin=<origin>[,<origin>…]');
        }
        if (!\extension_loaded('openssl')) {
            throw new UsageError('trust mode 2 needs the PHP extension openssl (docs/CRYPTO.md §7.4); nothing was pinned');
        }
        $origins = explode(',', $options['origin']);
        $passkeys = [];
        foreach (explode(',', $options['passkey'] ?? '') as $key) {
            try {
                $point = Base64Url::decodeLength($key, Es256::POINT_BYTES);
                if (!Es256::isOnCurve($point)) {
                    throw new UsageError('--passkey is not a point on the P-256 curve');
                }
                $passkeys[] = new PinnedPasskey($point, $options['rp-id'], $origins);
            } catch (Rejection) {
                throw new UsageError('--passkey needs the 65-byte uncompressed P-256 public key(s), base64url (87 characters each)');
            } catch (\InvalidArgumentException $error) {
                throw new UsageError($error->getMessage());
            }
        }

        return $passkeys;
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
            if (preg_match('/^--([a-z][a-z-]*)=(.*)$/sD', $arg, $match) === 1) {
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
