<?php

declare(strict_types=1);

namespace Moat\Gate\Json;

/**
 * A decoded JSON object. PHP arrays turn the key "1" into the integer 1 and cannot tell `{}` from
 * `[]`, so objects keep their own type and their keys stay strings.
 */
final readonly class JsonObject
{
    /** @param array<string, mixed> $members key → decoded JSON value */
    public function __construct(private array $members) {}

    /** @return list<string> */
    public function keys(): array
    {
        return array_map(strval(...), array_keys($this->members));
    }

    public function has(string $key): bool
    {
        return \array_key_exists($key, $this->members);
    }

    /** The decoded value, or null for a missing key — use has() where that matters. */
    public function get(string $key): mixed
    {
        return $this->members[$key] ?? null;
    }

    /** True when the object has exactly these keys — strict envelopes (SEC-20, SEC-24). */
    public function hasExactKeys(string ...$keys): bool
    {
        $own = $this->keys();
        if (\count($own) !== \count($keys)) {
            return false;
        }
        foreach ($keys as $key) {
            if (!\in_array($key, $own, true)) {
                return false;
            }
        }

        return true;
    }

    /** @return array<string, mixed> */
    public function members(): array
    {
        return $this->members;
    }
}
