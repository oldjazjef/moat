<?php

declare(strict_types=1);

namespace Moat\Gate\Encoding;

/** RFC 4648 base32, upper case, no padding — used only for human fingerprints. */
final class Base32
{
    private const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

    public static function encode(string $bytes): string
    {
        $out = '';
        $buffer = 0;
        $bits = 0;
        $length = \strlen($bytes);
        for ($index = 0; $index < $length; $index++) {
            $buffer = ($buffer << 8) | \ord($bytes[$index]);
            $bits += 8;
            while ($bits >= 5) {
                $bits -= 5;
                $out .= self::ALPHABET[($buffer >> $bits) & 31];
            }
            $buffer &= (1 << $bits) - 1;
        }
        if ($bits > 0) {
            $out .= self::ALPHABET[($buffer << (5 - $bits)) & 31];
        }

        return $out;
    }
}
