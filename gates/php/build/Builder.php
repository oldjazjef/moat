<?php

declare(strict_types=1);

namespace Moat\Gate\Build;

/**
 * Builds the one gate file (CLAUDE.md, PHP standards; SEC-21): every file under src/ as a
 * bracketed namespace block, sorted by path, then the entry point. No Phar, nothing generated from
 * config — the output depends only on src/, the version and the commit, so a rebuild of the same
 * commit gives the same bytes. The header carries the SHA-256 of everything after it.
 */
final class Builder
{
    public const SEPARATOR = "// ---- end of header ----\n";

    public static function build(string $srcDir, string $version, string $commit): string
    {
        if (preg_match('/^[0-9A-Za-z.+-]{1,64}$/D', $version . $commit) !== 1) {
            throw new \InvalidArgumentException('version and commit must be plain tokens');
        }
        $files = [];
        $iterator = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($srcDir, \FilesystemIterator::SKIP_DOTS));
        foreach ($iterator as $file) {
            if ($file instanceof \SplFileInfo && $file->getExtension() === 'php') {
                $files[] = $file->getPathname();
            }
        }
        sort($files, SORT_STRING);

        $body = '';
        foreach ($files as $path) {
            $code = file_get_contents($path);
            if ($code === false) {
                throw new \RuntimeException("cannot read {$path}");
            }
            $body .= '// ' . substr($path, \strlen($srcDir) + 1) . "\n" . self::block($code) . "\n";
        }
        $body .= "namespace {\n    \\Moat\\Gate\\Kernel::run(__FILE__);\n}\n";

        $header = "<?php\n\ndeclare(strict_types=1);\n\n"
            . "// Moat Gate for PHP — https://github.com/oldjazjef/moat (MIT)\n"
            . "// version: {$version}\n"
            . "// commit: {$commit}\n"
            . '// sha256 of everything after the header: ' . hash('sha256', $body) . "\n"
            . "// Do not edit: a changed file is not the released gate (SEC-21, SEC-60).\n"
            . self::SEPARATOR;

        return $header . $body;
    }

    /** One source file → `namespace X { … }`, without its open tag and strict_types declaration. */
    private static function block(string $code): string
    {
        $tokens = token_get_all($code);
        $namespace = '';
        $out = '';
        $state = 'start';
        foreach ($tokens as $token) {
            $text = \is_array($token) ? $token[1] : $token;
            $id = \is_array($token) ? $token[0] : null;
            if ($state === 'start') {
                if ($id === T_OPEN_TAG || $id === T_WHITESPACE) {
                    continue;
                }
                if ($id === T_DECLARE) {
                    $state = 'declare';

                    continue;
                }
                if ($id === T_NAMESPACE) {
                    $state = 'namespace';

                    continue;
                }
                throw new \RuntimeException('a source file must start with declare(strict_types=1) and a namespace');
            }
            if ($state === 'declare') {
                if ($text === ';') {
                    $state = 'start';
                }

                continue;
            }
            if ($state === 'namespace') {
                if ($text === ';') {
                    $state = 'body';
                } elseif ($id !== T_WHITESPACE) {
                    $namespace .= $text;
                }

                continue;
            }
            if ($id === T_CLOSE_TAG) {
                throw new \RuntimeException('no closing tag in source files');
            }
            $out .= $text;
        }
        if ($namespace === '' || $state !== 'body') {
            throw new \RuntimeException('a source file without a namespace');
        }

        return "namespace {$namespace} {\n" . trim($out) . "\n}\n";
    }
}
