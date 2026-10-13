<?php

declare(strict_types=1);

namespace Moat\Gate\Tests\Conformance;

use Moat\Gate\Config\Budget;
use Moat\Gate\Config\ConfigValidator;
use Moat\Gate\Config\Usage;
use Moat\Gate\Config\UsageFormat;
use Moat\Gate\Json\StrictJson;
use Moat\Gate\RejectionCode;
use Moat\Gate\Runtime\BudgetStore;
use Moat\Gate\Storage\DataDir;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * The PHP gate against conformance/vectors/http/budget.json (FR-31, SEC-45, T-07), as libs/core:
 * amounts, reading usage from an answer's exact text, charges, and sequences run through the real
 * budget store.
 */
final class BudgetVectorsTest extends TestCase
{
    private const FILE = 'http/budget.json';

    /** @return iterable<string, array{array<string, mixed>}> */
    public static function amounts(): iterable
    {
        foreach (Vectors::list(Vectors::load(self::FILE)['amounts'] ?? null) as $case) {
            $case = Vectors::map($case);
            yield '"' . Vectors::string($case['text']) . '"' => [$case];
        }
    }

    /** @return iterable<string, array{array<string, mixed>}> */
    public static function usage(): iterable
    {
        return Vectors::cases(self::FILE, 'usage');
    }

    /** @return iterable<string, array{array<string, mixed>}> */
    public static function charges(): iterable
    {
        return Vectors::cases(self::FILE, 'charges');
    }

    /** @return iterable<string, array{array<string, mixed>}> */
    public static function requests(): iterable
    {
        return Vectors::cases(self::FILE, 'requests');
    }

    /** @return iterable<string, array{array<string, mixed>}> */
    public static function sequences(): iterable
    {
        return Vectors::cases(self::FILE, 'sequences');
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('amounts')]
    public function testAmount(array $case): void
    {
        self::assertSame($case['expect'], Budget::amount($case['text']));
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('usage')]
    public function testUsage(array $case): void
    {
        $usage = UsageFormat::from(Vectors::string($case['format']))->read(Vectors::string($case['body']));
        self::assertSame($case['expect'], $usage === null ? null : ['input' => $usage->input, 'output' => $usage->output]);
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('charges')]
    public function testCharge(array $case): void
    {
        [$tokens, $micros] = self::budget($case['cost'])->charge(self::usageOf($case['usage']));
        self::assertSame($case['expect'], ['tokens' => $tokens, 'micros' => $micros]);
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('requests')]
    public function testRequest(array $case): void
    {
        $estimate = UsageFormat::from(Vectors::string($case['format']))->estimate(Vectors::string($case['body']), Vectors::int($case['maxOutput']));
        self::assertSame($case['expect'], $estimate === null ? null : ['input' => $estimate->input, 'output' => $estimate->output]);
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('sequences')]
    public function testSequence(array $case): void
    {
        $dir = sys_get_temp_dir() . '/moat-budget-' . bin2hex(random_bytes(6));
        mkdir($dir, 0o700);
        $data = DataDir::create($dir);
        $budget = self::parse($case['budget']);
        $name = BudgetStore::routeName('chat', $budget);
        $budgets = [[$name, $budget]];
        $open = [];
        $results = [];
        foreach (Vectors::list($case['steps']) as $step) {
            $step = Vectors::map($step);
            $now = Vectors::int($step['now']);
            if (isset($step['request'])) {
                $estimate = self::usageOf($step['estimate']);
                [$refused, $resetAts] = BudgetStore::reserve($data, $budgets, $estimate, $now, [$name]);
                $open[Vectors::string($step['request'])] = [$resetAts, $estimate];
                $result = ['refused' => $refused];
            } else {
                [$resetAts, $estimate] = $open[Vectors::string($step['answer'])] ?? throw new \RuntimeException('no request');
                $answer = $step['result'];
                $charge = match (true) {
                    $answer === 'uncountable' => $budget->charge($estimate),
                    $answer === 'not_charged' => [0, 0],
                    default => $budget->charge(self::usageOf($answer)),
                };
                BudgetStore::settle($data, $budgets, $resetAts, $estimate, [$charge], $now);
                $result = [];
            }
            $spent = BudgetStore::spent($data, $name, $now);
            $results[] = $result + ['spent' => ['tokens' => $spent[0] ?? 0, 'micros' => $spent[1] ?? 0]];
        }
        self::assertSame($case['expect'], $results);
    }

    private static function budget(mixed $cost): Budget
    {
        return self::parse($cost === null
            ? ['usage' => 'openai', 'period' => 'day', 'maxOutputTokens' => 1, 'tokens' => 1]
            : ['usage' => 'openai', 'period' => 'day', 'maxOutputTokens' => 1, 'cost' => $cost]);
    }

    private static function parse(mixed $value): Budget
    {
        return ConfigValidator::budget(
            StrictJson::decode(json_encode($value, JSON_THROW_ON_ERROR)),
            RejectionCode::ConfigInvalid,
            true,
        );
    }

    private static function usageOf(mixed $value): Usage
    {
        $usage = Vectors::map($value);

        return new Usage(Vectors::int($usage['input']), Vectors::int($usage['output']));
    }
}
