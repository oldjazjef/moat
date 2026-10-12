<?php

declare(strict_types=1);

namespace Moat\Gate\Tests\Unit;

use Moat\Gate\Runtime\SecretEcho;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/** SEC-34 / T-16: an upstream that echoes the credential in any common encoding is caught. */
final class SecretEchoTest extends TestCase
{
    private const SECRET = 'pat-TEST/ONLY+tok=en';

    /** @return iterable<string, array{string}> */
    public static function echoes(): iterable
    {
        yield 'raw' => ['{"auth":"Bearer ' . self::SECRET . '"}'];
        yield 'JSON with escaped slashes' => [json_encode(['auth' => self::SECRET], JSON_THROW_ON_ERROR)];
        yield 'URL-encoded' => ['{"query":"key=' . rawurlencode(self::SECRET) . '"}'];
        yield 'form-encoded' => ['key=' . urlencode(self::SECRET)];
        yield 'base64' => ['{"b":"' . base64_encode(self::SECRET) . '"}'];
        yield 'base64url' => ['{"b":"' . rtrim(strtr(base64_encode(self::SECRET), '+/', '-_'), '=') . '"}'];
        yield 'hex' => ['{"h":"' . bin2hex(self::SECRET) . '"}'];
        yield 'HEX' => ['{"h":"' . strtoupper(bin2hex(self::SECRET)) . '"}'];
    }

    #[DataProvider('echoes')]
    public function testSec34AnEchoedSecretIsFound(string $body): void
    {
        self::assertTrue(SecretEcho::found($body, self::SECRET));
    }

    public function testAnOrdinaryAnswerPasses(): void
    {
        self::assertFalse(SecretEcho::found('{"id":"123","email":"a@example.com"}', self::SECRET));
    }
}
