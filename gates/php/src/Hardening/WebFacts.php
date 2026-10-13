<?php

declare(strict_types=1);

namespace Moat\Gate\Hardening;

use Moat\Gate\Json\JsonObject;
use Moat\Gate\Json\StrictJson;
use Moat\Gate\Storage\DataDir;

/**
 * What the gate's web server process sees of itself (SEC-49, SEC-49a): its user, whether it owns
 * the gate file, open_basedir, whether it may overwrite the gate file, allow_url_include. Only the
 * web process can tell — the CLI may run as another user with another php.ini — so the gate
 * records them on requests in the data file `webfacts`, and `check` reads them. `check --url`
 * leaves a random nonce in `checkreq`; the web process copies it, which proves that the URL
 * reached this very gate. Nothing here comes
 * from the request, and nothing is ever sent anywhere (SEC-40: no inbound management endpoint).
 */
final readonly class WebFacts
{
    public const FILE = 'webfacts';
    /** Written by `check --url` with a random nonce; the web process copies it into its facts. */
    public const CHECK_REQUEST = 'checkreq';
    /** Recorded again at most once a day unless something changed. */
    public const REFRESH_SECONDS = 24 * 60 * 60;

    public function __construct(
        public int $at,
        public string $sapi,
        public ?string $user,
        public ?int $uid,
        public ?bool $ownsFiles,
        public bool $openBasedir,
        public bool $codeWritable,
        public bool $allowUrlInclude,
        public ?string $check,
    ) {}

    /** Records the current process's facts when they are missing, changed or a day old. */
    public static function record(DataDir $data, string $gateFile, int $now): void
    {
        $previous = self::read($data);
        $posixUid = \function_exists('posix_geteuid') ? posix_geteuid() : null;
        // Without the posix extension: the owner of the file this process wrote last time.
        $uid = $posixUid ?? ($previous === null ? null : $data->owner(self::FILE));
        $check = self::checkRequest($data);
        $facts = self::observe($gateFile, $uid, $now, $check);
        if ($previous !== null && $previous->sameAs($facts) && $now - $previous->at < self::REFRESH_SECONDS) {
            return;
        }
        $data->write(self::FILE, $facts->encode());
        if ($uid === null && ($written = $data->owner(self::FILE)) !== null) {
            $data->write(self::FILE, self::observe($gateFile, $written, $now, $check)->encode());
        }
    }

    public static function read(DataDir $data): ?self
    {
        try {
            $bytes = $data->read(self::FILE);

            return $bytes === null ? null : self::parse($bytes);
        } catch (\RuntimeException) {
            return null;
        }
    }

    /** The nonce of a pending `check --url`, or null. Only this local data file, never the request. */
    public static function checkRequest(DataDir $data): ?string
    {
        try {
            $bytes = $data->read(self::CHECK_REQUEST);
        } catch (\RuntimeException) {
            return null;
        }
        $bytes = $bytes === null ? '' : trim($bytes);

        return preg_match('/^[0-9a-f]{32}$/D', $bytes) === 1 ? $bytes : null;
    }

    public static function parse(string $bytes): ?self
    {
        $value = StrictJson::decode($bytes);
        if (!$value instanceof JsonObject || !$value->hasExactKeys('v', 'at', 'sapi', 'user', 'uid', 'ownsFiles', 'openBasedir', 'codeWritable', 'allowUrlInclude', 'check') || $value->get('v') !== 1) {
            return null;
        }
        [$at, $sapi, $user, $uid, $owns] = [$value->get('at'), $value->get('sapi'), $value->get('user'), $value->get('uid'), $value->get('ownsFiles')];
        [$basedir, $writable, $urlInclude, $check] = [$value->get('openBasedir'), $value->get('codeWritable'), $value->get('allowUrlInclude'), $value->get('check')];
        if (!\is_int($at) || !\is_string($sapi) || !($user === null || \is_string($user)) || !($uid === null || \is_int($uid))
            || !($owns === null || \is_bool($owns)) || !\is_bool($basedir) || !\is_bool($writable) || !\is_bool($urlInclude) || !($check === null || \is_string($check))) {
            return null;
        }

        return new self($at, $sapi, $user, $uid, $owns, $basedir, $writable, $urlInclude, $check);
    }

    public function encode(): string
    {
        return json_encode([
            'v' => 1,
            'at' => $this->at,
            'sapi' => $this->sapi,
            'user' => $this->user,
            'uid' => $this->uid,
            'ownsFiles' => $this->ownsFiles,
            'openBasedir' => $this->openBasedir,
            'codeWritable' => $this->codeWritable,
            'allowUrlInclude' => $this->allowUrlInclude,
            'check' => $this->check,
        ], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES) . "\n";
    }

    private static function observe(string $gateFile, ?int $uid, int $now, ?string $check): self
    {
        $user = null;
        if ($uid !== null && \function_exists('posix_getpwuid')) {
            // The user name is what SEC-49a needs (is it www-data?). It goes only into the guarded
            // data file and the CLI output on this server, never into a response or a log.
            $entry = posix_getpwuid($uid); // @phpstan-ignore disallowed.function
            $user = \is_array($entry) ? $entry['name'] : null;
        }
        $owner = fileowner($gateFile);
        $basedir = \ini_get('open_basedir');

        return new self(
            $now,
            PHP_SAPI,
            $user,
            $uid,
            $uid === null || $owner === false ? null : $uid === $owner,
            \is_string($basedir) && trim($basedir) !== '',
            is_writable($gateFile),
            filter_var(\ini_get('allow_url_include'), FILTER_VALIDATE_BOOLEAN),
            $check,
        );
    }

    private function sameAs(self $other): bool
    {
        return $this->sapi === $other->sapi && $this->user === $other->user && $this->uid === $other->uid
            && $this->ownsFiles === $other->ownsFiles && $this->openBasedir === $other->openBasedir
            && $this->codeWritable === $other->codeWritable && $this->allowUrlInclude === $other->allowUrlInclude
            && $this->check === $other->check;
    }
}
