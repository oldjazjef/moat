<?php

declare(strict_types=1);

namespace Moat\Gate\Tests\Unit;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * CLAUDE.md, PHP standards: the constructs PHPStan's disallowed-calls cannot express, checked
 * token by token in every source file — `@`, backticks, `$$variable`, eval, and include/require
 * of anything but a literal path. The same scan will run on the built single file.
 */
final class BannedConstructsTest extends TestCase
{
    /** @return iterable<string, array{string}> */
    public static function sourceFiles(): iterable
    {
        $root = \dirname(__DIR__, 2) . '/src';
        $files = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($root, \FilesystemIterator::SKIP_DOTS));
        foreach ($files as $file) {
            if ($file instanceof \SplFileInfo && $file->getExtension() === 'php') {
                yield substr($file->getPathname(), \strlen($root) + 1) => [$file->getPathname()];
            }
        }
    }

    #[DataProvider('sourceFiles')]
    public function testNoBannedConstruct(string $path): void
    {
        $code = file_get_contents($path);
        self::assertIsString($code);
        $tokens = array_values(array_filter(
            token_get_all($code),
            static fn(array|string $token): bool => !\is_array($token) || !\in_array($token[0], [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT], true),
        ));
        $found = [];
        foreach ($tokens as $index => $token) {
            $next = $tokens[$index + 1] ?? null;
            if ($token === '@') {
                $found[] = 'the @ operator';
            } elseif ($token === '`') {
                $found[] = 'backticks';
            } elseif ($token === '$' && (\is_array($next) && $next[0] === T_VARIABLE || $next === '{')) {
                $found[] = 'a variable variable';
            } elseif (\is_array($token) && $token[0] === T_EVAL) {
                $found[] = 'eval';
            } elseif (\is_array($token) && \in_array($token[0], [T_INCLUDE, T_INCLUDE_ONCE, T_REQUIRE, T_REQUIRE_ONCE], true)) {
                $after = $tokens[$index + 2] ?? null;
                $literal = \is_array($next) && $next[0] === T_CONSTANT_ENCAPSED_STRING && $after === ';';
                if (!$literal) {
                    $found[] = 'include/require of a non-literal path';
                }
            }
        }
        self::assertSame([], $found);
    }
}
