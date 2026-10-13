<?php

declare(strict_types=1);

namespace Moat\Gate\Hardening;

/**
 * The hardening check (SEC-49, SEC-49a) as libs/core/src/gate/hardening.ts: facts → level and
 * findings. The level is never stronger than what was checked (ANFORDERUNGEN.md §1.5): without
 * fresh facts of the web process, a clear process user and a passed check from outside there is
 * none, and any "unsafe" finding makes the gate «Unsicher für Secrets».
 */
final class Hardening
{
    /** Users that web servers run as for every site on a host. */
    public const GENERIC_WEB_USERS = ['apache', 'apache2', 'daemon', 'http', 'httpd', 'lighttpd', 'nginx', 'nobody', 'www', 'www-data', 'wwwrun', '_www'];
    public const STALE_SECONDS = 7 * 24 * 60 * 60;

    /**
     * Whose user the web process runs as: "shared" for a generic web server name (whoever owns the
     * gate file), "per_site" only for a known, non-generic name that owns the gate file, an unknown
     * name "shared" unless it owns the file, else "unclear".
     */
    public static function webUser(WebFacts $web): string
    {
        if ($web->user === null) {
            return $web->ownsFiles === true ? 'unclear' : 'shared';
        }
        if (\in_array($web->user, self::GENERIC_WEB_USERS, true)) {
            return 'shared';
        }

        return $web->ownsFiles === true ? 'per_site' : 'unclear';
    }

    public static function classify(Facts $facts): Report
    {
        $found = [];
        $web = $facts->web;
        if ($web === null) {
            $found[] = Finding::WebNotSeen;
        } else {
            if ($facts->now - $web->at > self::STALE_SECONDS) {
                $found[] = Finding::WebFactsStale;
            }
            $user = self::webUser($web);
            if ($user === 'shared') {
                $found[] = $web->openBasedir ? Finding::SharedUserBasedir : Finding::SharedUser;
            } elseif ($user === 'unclear') {
                $found[] = Finding::UserUnclear;
            }
            if ($web->codeWritable) {
                $found[] = Finding::CodeWritable;
            }
            if ($web->allowUrlInclude) {
                $found[] = Finding::UrlInclude;
            }
        }
        $found[] = match ($facts->external) {
            External::Reachable => Finding::DataReachable,
            External::NotChecked => Finding::ExternalNotChecked,
            External::Failed => Finding::ExternalFailed,
            External::NotGate => Finding::ExternalNotGate,
            External::Blocked => null,
        };
        $found[] = match ($facts->policy) {
            PolicyState::Testing => Finding::PolicyTesting,
            PolicyState::Missing => Finding::PolicyMissing,
            PolicyState::Installed => null,
        };
        if ($facts->dataPermissionsOpen) {
            $found[] = Finding::DataPermissionsOpen;
        }
        $found[] = Finding::DataInWebroot;

        $findings = array_values(array_filter(Finding::cases(), static fn(Finding $code): bool => \in_array($code, $found, true)));
        $unsafe = array_filter($findings, static fn(Finding $code): bool => $code->severity() === 'unsafe') !== [];
        $blocked = array_filter($findings, static fn(Finding $code): bool => $code->blocksLevel()) !== [];
        $level = match (true) {
            $unsafe => Level::Unsafe,
            $blocked => null,
            default => Level::H1,
        };

        return new Report($level, $findings);
    }
}
