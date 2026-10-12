<?php

declare(strict_types=1);

// php build/build.php [--version=0.0.0-dev] [--commit=unknown] [--out=dist/moat-gate.php]
// Writes the single gate file and prints its SHA-256.

namespace Moat\Gate\Build;

require __DIR__ . '/Builder.php';

$options = getopt('', ['version:', 'commit:', 'out:']);
$options = $options === false ? [] : $options;
$text = static fn(string $key, string $default): string => \is_string($options[$key] ?? null) ? $options[$key] : $default;
$out = $text('out', \dirname(__DIR__) . '/dist/moat-gate.php');
$code = Builder::build(\dirname(__DIR__) . '/src', $text('version', '0.0.0-dev'), $text('commit', 'unknown'));
if (!is_dir(\dirname($out)) && !mkdir(\dirname($out), 0o755, true)) {
    fwrite(STDERR, "cannot create the output folder\n");
    exit(1);
}
if (file_put_contents($out, $code) !== \strlen($code)) {
    fwrite(STDERR, "cannot write {$out}\n");
    exit(1);
}
fwrite(STDOUT, $out . "\nsha256 " . hash('sha256', $code) . "\n");
