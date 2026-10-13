<?php

declare(strict_types=1);

namespace Moat\Gate\Tests\Unit;

use Moat\Gate\Config\Budget;
use Moat\Gate\Config\Cost;
use Moat\Gate\Config\QuotaPeriod;
use Moat\Gate\Config\Usage;
use Moat\Gate\Config\UsageFormat;
use Moat\Gate\Runtime\BudgetStore;
use Moat\Gate\Storage\DataDir;
use PHPUnit\Framework\TestCase;

/** The spending store behind FR-31 budgets, attacked: flooding, tampering, several budgets at once. */
final class BudgetStoreTest extends TestCase
{
    private const NOW = 1_791_763_200; // 2026-10-12 00:00 UTC

    private DataDir $data;

    protected function setUp(): void
    {
        $dir = sys_get_temp_dir() . '/moat-budget-' . bin2hex(random_bytes(6));
        mkdir($dir, 0o700);
        $this->data = DataDir::create($dir);
    }

    /**
     * One request through the store: reserve, then settle with what the answer used.
     *
     * @param list<array{string, Budget}> $budgets
     * @param list<string> $routeBudgets
     */
    private function pass(array $budgets, Usage $usage, int $now, array $routeBudgets): ?int
    {
        [$refused, $resetAts] = BudgetStore::reserve($this->data, $budgets, $now, $routeBudgets);
        if ($refused === null) {
            BudgetStore::settle($this->data, $budgets, $resetAts, array_map(static fn(array $entry): array => $entry[1]->charge($usage), $budgets), $now);
        }

        return $refused;
    }

    public function testFr31TheHostBudgetOfThePolicyRefusesWhateverTheRouteAllows(): void
    {
        $host = new Budget(UsageFormat::OpenAi, QuotaPeriod::Day, 10, 100, null);
        $route = new Budget(UsageFormat::OpenAi, QuotaPeriod::Month, 10, 1_000_000, null);
        $budgets = [[BudgetStore::hostName('api.openai.com', $host), $host], [BudgetStore::routeName('chat', $route), $route]];
        self::assertNull($this->pass($budgets, new Usage(80, 20), self::NOW + 10, ['route chat month']));
        self::assertSame(86_390, $this->pass($budgets, new Usage(1, 0), self::NOW + 10, ['route chat month']));
        // The next day the host budget has room again; the route's month runs on.
        self::assertNull($this->pass($budgets, new Usage(1, 0), self::NOW + 86_400, ['route chat month']));
        self::assertSame([101, 0, 1_793_491_200], BudgetStore::spent($this->data, 'route chat month', self::NOW + 86_400));
    }

    public function testT07ParallelRequestsCountWithTheirReservation(): void
    {
        // With 1 token left, only one request may be in flight: the next sees its reservation.
        $budget = new Budget(UsageFormat::OpenAi, QuotaPeriod::Day, 4096, 10_000, null);
        $budgets = [['route chat day', $budget]];
        self::assertNull($this->pass($budgets, new Usage(9_000, 999), self::NOW, ['route chat day']));
        [$first] = BudgetStore::reserve($this->data, $budgets, self::NOW + 1, ['route chat day']);
        [$second] = BudgetStore::reserve($this->data, $budgets, self::NOW + 2, ['route chat day']);
        self::assertNull($first);
        self::assertSame(86_398, $second);
        self::assertSame(9_999 + 4_096, BudgetStore::spent($this->data, 'route chat day', self::NOW + 2)[0] ?? null);
    }

    public function testFr31TheLongestRefusalWins(): void
    {
        $day = new Budget(UsageFormat::OpenAi, QuotaPeriod::Day, 1, 10, null);
        $month = new Budget(UsageFormat::OpenAi, QuotaPeriod::Month, 1, null, new Cost(1, 1_000_000, 1_000_000));
        $budgets = [['host h day', $day], ['route chat month', $month]];
        $this->pass($budgets, new Usage(10, 0), self::NOW, ['route chat month']);
        self::assertSame(1_793_491_200 - self::NOW, BudgetStore::reserve($this->data, $budgets, self::NOW, ['route chat month'])[0]);
    }

    public function testSec27RouteBudgetsOfEarlierBundlesCannotFillTheStore(): void
    {
        // A compromised Cloud renaming a budgeted route bundle after bundle: the spending of
        // routes no longer in force is dropped, the policy's host budget is kept.
        $host = new Budget(UsageFormat::OpenAi, QuotaPeriod::Month, 1, 1_000_000_000, null);
        $route = new Budget(UsageFormat::OpenAi, QuotaPeriod::Month, 1, 1_000_000, null);
        for ($i = 0; $i < BudgetStore::MAX_ENTRIES + 10; ++$i) {
            $name = BudgetStore::routeName('r' . $i, $route);
            self::assertNull($this->pass([['host h month', $host], [$name, $route]], new Usage(1, 0), self::NOW, [$name]));
        }
        self::assertSame(BudgetStore::MAX_ENTRIES + 10, BudgetStore::spent($this->data, 'host h month', self::NOW)[0] ?? null);
        self::assertNull(BudgetStore::spent($this->data, 'route r0 month', self::NOW));
        self::assertSame(2, substr_count($this->data->read(BudgetStore::FILE) ?? '', "\n") - 1);
    }

    public function testSec27AFullStoreFailsClosedBeforeForwarding(): void
    {
        $budget = new Budget(UsageFormat::OpenAi, QuotaPeriod::Month, 1, 10, null);
        $budgets = [];
        for ($i = 0; $i <= BudgetStore::MAX_ENTRIES; ++$i) {
            $budgets[] = ['host h' . $i . ' month', $budget];
        }
        try {
            BudgetStore::reserve($this->data, $budgets, self::NOW, []);
            self::fail('a store beyond MAX_ENTRIES must be refused');
        } catch (\RuntimeException $e) {
            self::assertSame('budget store full', $e->getMessage());
        }
    }

    public function testSec27SpendingIsCappedSoTheStoreStaysReadable(): void
    {
        // A cost-only budget with free prices: the tokens grow with every answer, but never past
        // the cap, so the store never turns damaged and locks every budget.
        $budget = new Budget(UsageFormat::Anthropic, QuotaPeriod::Month, 1, null, new Cost(1, 0, 0));
        $budgets = [['route chat month', $budget]];
        $this->data->write(BudgetStore::FILE, "moat-budget-v1\n" . bin2hex(sodium_crypto_generichash('route chat month', '', 16)) . ' 1793491200 ' . (Budget::MAX_SPENT_TOKENS - 5) . " 0 r\n");
        self::assertNull($this->pass($budgets, new Usage(3_000_000_000, 1_000_000_000), self::NOW, ['route chat month']));
        self::assertSame(Budget::MAX_SPENT_TOKENS, BudgetStore::spent($this->data, 'route chat month', self::NOW)[0] ?? null);
    }

    public function testSec46ADamagedStoreRefusesEverything(): void
    {
        $budget = new Budget(UsageFormat::OpenAi, QuotaPeriod::Day, 1, 10, null);
        $this->data->write(BudgetStore::FILE, "moat-budget-v1\n" . str_repeat('0', 32) . " 9999999999 -5 0 r\n");
        try {
            BudgetStore::reserve($this->data, [['route chat day', $budget]], self::NOW, ['route chat day']);
            self::fail('a damaged store must refuse');
        } catch (\RuntimeException $e) {
            self::assertSame('budget store damaged', $e->getMessage());
        }
    }

    public function testSec47TheStoreHoldsNoRouteOrHostName(): void
    {
        $budget = new Budget(UsageFormat::OpenAi, QuotaPeriod::Day, 1, 10, null);
        $this->pass([['host api.openai.com day', $budget], ['route secret-route day', $budget]], new Usage(1, 2), self::NOW, ['route secret-route day']);
        $content = $this->data->read(BudgetStore::FILE) ?? '';
        self::assertStringNotContainsString('openai', $content);
        self::assertStringNotContainsString('secret-route', $content);
        self::assertStringContainsString(' 3 0 h', $content);
    }
}
