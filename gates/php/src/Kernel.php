<?php

declare(strict_types=1);

namespace Moat\Gate;

use Moat\Gate\Cli\Cli;
use Moat\Gate\Hardening\WebFacts;
use Moat\Gate\Http\GateError;
use Moat\Gate\Http\Request;
use Moat\Gate\Http\Response;
use Moat\Gate\Runtime\BundlePull;
use Moat\Gate\Runtime\Gate;
use Moat\Gate\Runtime\NotConfigured;
use Moat\Gate\Runtime\PullOutcome;
use Moat\Gate\Runtime\RequestHandler;
use Moat\Gate\Storage\DataDir;

/**
 * The entry point of the built gate file. Sets its own safe runtime instead of trusting php.ini
 * (CLAUDE.md, PHP standards): no error display, every warning an exception, a last-resort
 * handler that logs a code only and answers a generic error (SEC-34, SEC-46).
 */
final class Kernel
{
    public const REQUIRED_EXTENSIONS = ['sodium', 'curl', 'json', 'hash'];

    public static function run(string $gateFile): void
    {
        $gateDir = \dirname($gateFile);
        ini_set('display_errors', '0');
        ini_set('html_errors', '0');
        ini_set('log_errors', '1');
        // No PHP default Content-Type (text/html) on answers without a body, e.g. a preflight.
        ini_set('default_mimetype', '');
        error_reporting(E_ALL);
        set_error_handler(static function (int $severity, string $message, string $file, int $line): never {
            throw new \ErrorException('php_error', 0, $severity, $file, $line);
        });

        if (PHP_SAPI === 'cli') {
            $argv = array_values(array_filter(
                \is_array($_SERVER['argv'] ?? null) ? $_SERVER['argv'] : [],
                \is_string(...),
            ));
            exit(self::missingExtension() === null ? Cli::main($gateDir, $argv) : self::cliFailure());
        }

        ob_start();
        set_exception_handler(static function (\Throwable $error): void {
            self::log($error);
            Response::error(GateError::Internal)->send();
        });
        if (self::missingExtension() !== null) {
            self::log(null, 'extension_missing');
            Response::error(GateError::GateNotConfigured)->send();

            return;
        }
        $data = DataDir::locate($gateDir);
        if ($data !== null) {
            try {
                WebFacts::record($data, $gateFile, time());
            } catch (\Throwable $error) {
                // The hardening check then reports old or missing facts; the request goes on.
                self::log($error, 'web_facts_unwritable');
            }
        }
        try {
            $gate = Gate::open($gateDir);
            self::pull($gate);
            $bundle = $gate->active(time());
        } catch (NotConfigured) {
            self::log(null, 'gate_not_configured');
            Response::error(GateError::GateNotConfigured)->send();

            return;
        }
        RequestHandler::handle(Request::fromServer($_SERVER), $bundle, $gate, time())->send();
    }

    /**
     * The lazy pull (DT-11) before the active bundle is read, so a bundle it accepts serves this
     * request. Never stops the request: anything that goes wrong is logged as a code.
     */
    private static function pull(Gate $gate): void
    {
        try {
            $record = BundlePull::ifDue($gate, time());
        } catch (\Throwable $error) {
            self::log($error, 'pull_failed');

            return;
        }
        if ($record !== null && $record->outcome !== PullOutcome::Accepted && $record->outcome !== PullOutcome::Unchanged) {
            self::log(null, 'pull_' . ($record->outcome->value ?? 'unknown') . ($record->reason === null ? '' : ' ' . $record->reason));
        }
    }

    private static function missingExtension(): ?string
    {
        foreach (self::REQUIRED_EXTENSIONS as $extension) {
            if (!\extension_loaded($extension)) {
                return $extension;
            }
        }

        return null;
    }

    private static function cliFailure(): int
    {
        fwrite(STDERR, 'missing PHP extension: ' . self::missingExtension() . "\n");

        return 1;
    }

    /** Codes and class names only — never a message, value or trace that could hold a secret. */
    public static function log(?\Throwable $error, string $code = 'internal_error'): void
    {
        error_log('moat-gate: ' . $code . ($error === null ? '' : ' (' . $error::class . ')'));
    }
}
