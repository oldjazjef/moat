<?php

declare(strict_types=1);

namespace Moat\Gate\Runtime;

use Moat\Gate\Config\Budget;
use Moat\Gate\Config\Route;
use Moat\Gate\Storage\DataDir;

/**
 * What the budgets (FR-31, SEC-45) have spent in their current period, in the data file
 * `budget.php`: one line per budget, `<id> <resetAt> <tokens> <micros> <r|h>`, the id a hash of
 * the budget's name (route or host, and period), `r` for a route's budget. The spending includes
 * the reservations of requests in flight, and is capped (Budget::MAX_SPENT_*). Expired periods are
 * dropped on every write, and so are the budgets of routes the bundle in force does not have: a
 * compromised Cloud renaming routes bundle after bundle cannot fill the store (SEC-27; a bundle
 * has at most 256 route budgets, and a full store fails closed). The policy's host budgets stay
 * whatever the bundle does. Read and written under the data folder's lock, like the rate-limit
 * store.
 */
final class BudgetStore
{
    public const FILE = 'budget';
    public const MAX_ENTRIES = 1024;
    private const HEADER = 'moat-budget-v1';

    /**
     * Before forwarding (budgetRefusal() and addCharge() in libs/core): refused with the seconds
     * until the last exhausted budget's period ends, or every budget gets the request's
     * reservation. Returns the end of each budget's period, which settle() needs.
     *
     * @param list<array{string, Budget}> $budgets
     * @param list<string> $routeBudgets the names of every route budget in the bundle in force
     *
     * @return array{?int, list<int>} retry-after or null, and each budget's period end
     *
     * @throws \RuntimeException when the store is damaged, full or cannot be written
     */
    public static function reserve(DataDir $data, array $budgets, int $now, array $routeBudgets): array
    {
        return $data->locked(static function () use ($data, $budgets, $now, $routeBudgets): array {
            $spent = self::live($data, $now, $routeBudgets);
            $retryAfter = null;
            foreach ($budgets as [$name, $budget]) {
                $entry = $spent[self::id($name)] ?? null;
                if ($entry !== null && $budget->exhausted($entry[1], $entry[2])) {
                    $retryAfter = max($retryAfter ?? 0, $entry[0] - $now);
                }
            }
            if ($retryAfter !== null) {
                return [$retryAfter, []];
            }
            $resetAts = [];
            foreach ($budgets as [$name, $budget]) {
                $id = self::id($name);
                [$tokens, $micros] = $budget->reservation();
                $entry = $spent[$id] ?? [$budget->period->end($now), 0, 0, str_starts_with($name, 'route ')];
                $spent[$id] = [$entry[0], self::add($entry[1], $tokens, Budget::MAX_SPENT_TOKENS), self::add($entry[2], $micros, Budget::MAX_SPENT_MICROS), $entry[3]];
                $resetAts[] = $entry[0];
            }
            self::save($data, $spent);

            return [null, $resetAts];
        });
    }

    /**
     * After the answer (settle() in libs/core): each budget's reservation is replaced by what the
     * answer costs it — unless the period the reservation was made in has ended.
     *
     * @param list<array{string, Budget}> $budgets
     * @param list<int> $resetAts what reserve() returned
     * @param list<array{int, int}> $charges per budget: tokens and micros the answer costs
     *
     * @throws \RuntimeException when the store is damaged or cannot be written
     */
    public static function settle(DataDir $data, array $budgets, array $resetAts, array $charges, int $now): void
    {
        $data->locked(static function () use ($data, $budgets, $resetAts, $charges, $now): void {
            $spent = self::load($data->read(self::FILE), $now);
            foreach ($budgets as $i => [$name, $budget]) {
                $id = self::id($name);
                $entry = $spent[$id] ?? null;
                if ($entry === null || $entry[0] !== ($resetAts[$i] ?? null)) {
                    continue;
                }
                [$reservedTokens, $reservedMicros] = $budget->reservation();
                [$tokens, $micros] = $charges[$i] ?? [0, 0];
                $spent[$id] = [
                    $entry[0],
                    self::add(max(0, $entry[1] - $reservedTokens), $tokens, Budget::MAX_SPENT_TOKENS),
                    self::add(max(0, $entry[2] - $reservedMicros), $micros, Budget::MAX_SPENT_MICROS),
                    $entry[3],
                ];
            }
            self::save($data, $spent);
        });
    }

    /**
     * What a budget has spent in its current period: `[tokens, micros, resetAt]`, or null.
     *
     * @return ?array{int, int, int}
     */
    public static function spent(DataDir $data, string $name, int $now): ?array
    {
        $entry = self::load($data->read(self::FILE), $now)[self::id($name)] ?? null;

        return $entry === null ? null : [$entry[1], $entry[2], $entry[0]];
    }

    /**
     * The store names of every route budget in a bundle.
     *
     * @param array<string, Route> $routes
     *
     * @return list<string>
     */
    public static function routeBudgets(array $routes): array
    {
        $names = [];
        foreach ($routes as $name => $route) {
            if ($route->budget !== null) {
                $names[] = self::routeName($name, $route->budget);
            }
        }

        return $names;
    }

    /** The store name of a route's budget. */
    public static function routeName(string $route, Budget $budget): string
    {
        return 'route ' . $route . ' ' . $budget->period->value;
    }

    /** The store name of the local policy's budget for an upstream host. */
    public static function hostName(string $hostKey, Budget $budget): string
    {
        return 'host ' . $hostKey . ' ' . $budget->period->value;
    }

    /**
     * The entries still running, without route budgets the bundle in force does not have.
     *
     * @param list<string> $routeBudgets
     *
     * @return array<string, array{int, int, int, bool}>
     */
    private static function live(DataDir $data, int $now, array $routeBudgets): array
    {
        $live = array_flip(array_map(self::id(...), $routeBudgets));

        return array_filter(
            self::load($data->read(self::FILE), $now),
            static fn(array $entry, string $id): bool => !$entry[3] || isset($live[$id]),
            ARRAY_FILTER_USE_BOTH,
        );
    }

    /**
     * SEC-27: a store over MAX_ENTRIES is refused (fail closed); route budgets are bounded by the
     * bundle check, so only an unusually long list of policy host budgets can reach it.
     *
     * @param array<string, array{int, int, int, bool}> $spent
     */
    private static function save(DataDir $data, array $spent): void
    {
        if (\count($spent) > self::MAX_ENTRIES) {
            throw new \RuntimeException('budget store full');
        }
        $lines = self::HEADER . "\n";
        foreach ($spent as $id => [$resetAt, $tokens, $micros, $route]) {
            $lines .= $id . ' ' . $resetAt . ' ' . $tokens . ' ' . $micros . ' ' . ($route ? 'r' : 'h') . "\n";
        }
        $data->write(self::FILE, $lines);
    }

    /** `$a + $b`, at most `$max` (both are at most 10^17, so the sum fits in 64 bits). */
    private static function add(int $a, int $b, int $max): int
    {
        return min($max, $a + $b);
    }

    private static function id(string $name): string
    {
        return bin2hex(sodium_crypto_generichash($name, '', 16));
    }

    /**
     * The entries whose period is still running at `$now`.
     *
     * @return array<string, array{int, int, int, bool}> id → resetAt, tokens, micros, route budget
     */
    private static function load(?string $content, int $now): array
    {
        if ($content === null) {
            return [];
        }
        $lines = explode("\n", $content);
        if (array_pop($lines) !== '' || ($lines[0] ?? '') !== self::HEADER) {
            throw new \RuntimeException('budget store damaged');
        }
        $spent = [];
        foreach (\array_slice($lines, 1) as $line) {
            if (preg_match('/^([0-9a-f]{32}) ([1-9][0-9]{0,11}) (0|[1-9][0-9]{0,15}) (0|[1-9][0-9]{0,17}) ([rh])$/D', $line, $match) !== 1) {
                throw new \RuntimeException('budget store damaged');
            }
            if ((int) $match[2] > $now) {
                $spent[$match[1]] = [(int) $match[2], (int) $match[3], (int) $match[4], $match[5] === 'r'];
            }
        }

        return $spent;
    }
}
