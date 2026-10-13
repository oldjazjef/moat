<?php

declare(strict_types=1);

namespace Moat\Gate\Hardening;

/**
 * The closed list of hardening findings, in the order a report lists them (libs/core/src/gate/
 * hardening.ts, conformance/vectors/gate/hardening.json).
 */
enum Finding: string
{
    case SharedUser = 'shared_user';
    case DataReachable = 'data_reachable';
    case PolicyTesting = 'policy_testing';
    case WebNotSeen = 'web_not_seen';
    case WebFactsStale = 'web_facts_stale';
    case SharedUserBasedir = 'shared_user_basedir';
    case UserUnclear = 'user_unclear';
    case ExternalNotChecked = 'external_not_checked';
    case ExternalFailed = 'external_failed';
    case ExternalNotGate = 'external_not_gate';
    case DataPermissionsOpen = 'data_permissions_open';
    case CodeWritable = 'code_writable';
    case UrlInclude = 'url_include';
    case PolicyMissing = 'policy_missing';
    case DataInWebroot = 'data_in_webroot';

    /** Leaves too much unchecked to claim any level (besides every "unsafe" finding). */
    public function blocksLevel(): bool
    {
        return \in_array($this, [self::WebNotSeen, self::WebFactsStale, self::UserUnclear, self::ExternalNotChecked, self::ExternalFailed, self::ExternalNotGate], true);
    }

    public function severity(): string
    {
        return match ($this) {
            self::SharedUser, self::DataReachable, self::PolicyTesting => 'unsafe',
            self::WebNotSeen, self::PolicyMissing, self::DataInWebroot => 'info',
            default => 'warn',
        };
    }

    /** One line for the CLI: what was found and what to do about it. */
    public function advice(): string
    {
        return match ($this) {
            self::SharedUser => 'PHP runs as a user all websites on this server share, and open_basedir is not set: other sites could read the keys (SEC-49a). Ask the hoster for a per-site PHP user (PHP-FPM pool, suEXEC) or move to H2/H3 before binding secrets.',
            self::DataReachable => 'Data files can be fetched from outside: the server ignores .htaccess/web.config or does not run PHP for them. Fix the server rules before binding secrets.',
            self::PolicyTesting => 'The local policy has a "testing" block (loopback upstreams, extra CA). Install a policy without it before binding secrets.',
            self::WebNotSeen => 'No request has reached the gate yet. Open the gate URL once (or pass --url), then run check again.',
            self::WebFactsStale => 'What the web server process reported is more than a week old. Open the gate URL once, then run check again.',
            self::SharedUserBasedir => 'PHP runs as a user all websites share, but open_basedir fences PHP in. Scripts in other languages are not fenced; a per-site user is better.',
            self::UserUnclear => 'It is not clear whether PHP runs as this website\'s own user (an unknown name, or not the owner of the gate file). Ask the hoster whether other websites share this user.',
            self::ExternalNotChecked => 'Not checked from outside. Run: php moat-gate.php check --url=https://<your site>/<path>/moat-gate.php',
            self::ExternalFailed => 'The check from outside could not reach the gate (DNS, TLS or network). Check the URL and that this server may call its own website.',
            self::ExternalNotGate => 'The URL does not answer like this gate, so the check from outside proves nothing. Pass the public URL of this gate file.',
            self::DataPermissionsOpen => 'The data folder or a data file can be read by the group or by everyone. Run: chmod 700 on the folder and 600 on the data files, if the hosting allows it.',
            self::CodeWritable => 'The web server process may overwrite the gate file. Make it read-only (chmod 444) where the hosting allows it.',
            self::UrlInclude => 'PHP may include code from URLs (allow_url_include). Switch it off in the hosting settings.',
            self::PolicyMissing => 'No local policy yet: the gate serves nothing. Run: php moat-gate.php policy <policy.json>',
            self::DataInWebroot => 'H1: keys and policy live in the webroot, protected by access rules only. This gate cannot keep them outside the webroot yet (H2).',
        };
    }
}
