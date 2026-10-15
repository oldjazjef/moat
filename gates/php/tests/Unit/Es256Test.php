<?php

declare(strict_types=1);

namespace Moat\Gate\Tests\Unit;

use Moat\Gate\Crypto\Es256;
use PHPUnit\Framework\TestCase;

/** The strict DER and the OpenSSL verification of trust mode 2 (docs/CRYPTO.md §7.3 steps 5 and 6) against real keys. */
final class Es256Test extends TestCase
{
    public function testEverySignatureOpenSslProducesIsStrictDerAndVerifies(): void
    {
        $key = openssl_pkey_new(['curve_name' => 'prime256v1', 'private_key_type' => OPENSSL_KEYTYPE_EC]);
        self::assertNotFalse($key);
        $details = openssl_pkey_get_details($key);
        $ec = \is_array($details) && \is_array($details['ec'] ?? null) ? $details['ec'] : [];
        $x = $ec['x'] ?? null;
        $y = $ec['y'] ?? null;
        if (!\is_string($x) || !\is_string($y)) {
            self::fail('no EC details');
        }
        $point = "\x04" . str_pad($x, 32, "\0", STR_PAD_LEFT) . str_pad($y, 32, "\0", STR_PAD_LEFT);
        self::assertTrue(Es256::isOnCurve($point));
        for ($round = 0; $round < 300; $round++) {
            $data = random_bytes(40);
            $der = '';
            self::assertTrue(openssl_sign($data, $der, $key, OPENSSL_ALGO_SHA256));
            self::assertTrue(Es256::isStrictDer($der), bin2hex($der));
            self::assertTrue(Es256::verify($point, $data, $der));
            self::assertFalse(Es256::verify($point, $data . 'x', $der));
            // One byte more, one byte less, a flipped bit: never accepted.
            self::assertFalse(Es256::verify($point, $data, $der . "\0"));
            self::assertFalse(Es256::verify($point, $data, substr($der, 0, -1)));
            $flipped = $der;
            $flipped[\strlen($der) - 1] = \chr(\ord($der[\strlen($der) - 1]) ^ 1);
            self::assertFalse(Es256::verify($point, $data, $flipped));
        }
    }

    public function testAPointThatIsNotOnTheCurveNeverVerifies(): void
    {
        $point = "\x04" . str_repeat("\1", 64);
        self::assertFalse(Es256::isOnCurve($point));
        self::assertFalse(Es256::verify($point, 'data', "\x30\x06\x02\x01\x01\x02\x01\x01"));
        self::assertFalse(Es256::isOnCurve("\x02" . str_repeat("\1", 64)));
        self::assertFalse(Es256::isOnCurve(str_repeat("\4", 64)));
    }

    public function testStrictDerRefusesWhatLibrariesTolerate(): void
    {
        $good = "\x30\x06\x02\x01\x01\x02\x01\x01";
        self::assertTrue(Es256::isStrictDer($good));
        self::assertFalse(Es256::isStrictDer($good . "\0"));
        self::assertFalse(Es256::isStrictDer("\x30\x81\x06" . substr($good, 2)), 'long-form length');
        self::assertFalse(Es256::isStrictDer("\x30\x07\x02\x02\x00\x01\x02\x01\x01"), 'non-minimal integer');
        self::assertFalse(Es256::isStrictDer("\x30\x06\x02\x01\x81\x02\x01\x01"), 'negative integer');
        self::assertFalse(Es256::isStrictDer("\x30\x06\x02\x01\x00\x02\x01\x01"), 'r = 0');
        self::assertFalse(Es256::isStrictDer("\x30\x06\x02\x01\x01\x02\x01\x00"), 's = 0');
        self::assertFalse(Es256::isStrictDer(''));
        $order = (string) hex2bin('ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
        self::assertFalse(Es256::isStrictDer("\x30\x26\x02\x21\x00" . $order . "\x02\x01\x01"), 'r = n');
        self::assertTrue(Es256::isStrictDer("\x30\x26\x02\x21\x00" . substr($order, 0, 31) . "\x50\x02\x01\x01"), 'r = n - 1');
    }

    public function testTheGrammarOfRelyingPartiesAndOrigins(): void
    {
        foreach (['moat.example.org', 'localhost', 'xn--bcher-kva.example'] as $rpId) {
            self::assertTrue(Es256::isRpId($rpId), $rpId);
        }
        foreach (['', 'Moat.example.org', 'moat.example.org.', '127.0.0.1', 'a..b', "moat.example.org\n", str_repeat('a', 254)] as $rpId) {
            self::assertFalse(Es256::isRpId($rpId), $rpId);
        }
        foreach (['app://moat', 'https://moat.example.org', 'https://moat.example.org:8443', 'https://a:65535'] as $origin) {
            self::assertTrue(Es256::isOrigin($origin), $origin);
        }
        foreach (['http://moat.example.org', 'https://moat.example.org/', 'https://moat.example.org:443', 'https://moat.example.org:65536', 'app://Moat', 'app://moat/', "app://moat\n", 'https://127.0.0.1'] as $origin) {
            self::assertFalse(Es256::isOrigin($origin), $origin);
        }
    }
}
