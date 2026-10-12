<?php

declare(strict_types=1);

namespace Moat\Gate\Runtime;

/**
 * SEC-34: an upstream answer that contains the secret — raw or in an encoding an echo or debug
 * endpoint would plausibly use — never reaches the client (T-16).
 */
final class SecretEcho
{
    public static function found(string $body, string $secret): bool
    {
        if ($secret === '') {
            return false;
        }
        $forms = [
            $secret,
            rawurlencode($secret),
            urlencode($secret),
            substr(json_encode($secret, JSON_THROW_ON_ERROR), 1, -1),
            substr(json_encode($secret, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), 1, -1),
            base64_encode($secret),
            rtrim(strtr(base64_encode($secret), '+/', '-_'), '='),
            bin2hex($secret),
            strtoupper(bin2hex($secret)),
        ];
        $found = false;
        foreach ($forms as $index => $form) {
            $found = $found || ($form !== '' && str_contains($body, $form));
            sodium_memzero($forms[$index]);
        }

        return $found;
    }
}
