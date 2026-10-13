<?php

declare(strict_types=1);

namespace Moat\Gate\Hardening;

/** The levels a hardening check can report (ANFORDERUNGEN.md §2.9). H2 and H3 are not claimed yet. */
enum Level: string
{
    case Unsafe = 'unsafe';
    case H1 = 'h1';

    /** The §2.9 label, in English (the CLI's language). */
    public function label(): string
    {
        return match ($this) {
            self::Unsafe => 'H1, Unsafe for secrets',
            self::H1 => 'H1, Basic',
        };
    }
}
