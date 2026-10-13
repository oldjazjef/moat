<?php

declare(strict_types=1);

namespace Moat\Gate\Config;

/**
 * A budget for an AI API (FR-31, T-07): tokens and/or cost per calendar day or month (UTC),
 * counted from the usage the answers report — as libs/core/src/http/budget.ts. In the local
 * policy (per upstream host) only tokens: prices come from the bundle.
 */
final readonly class Budget
{
    public const MICROS = 1_000_000;
    public const MAX_TOKENS = 1_000_000_000_000;
    public const MAX_AMOUNT_MICROS = 1_000_000_000 * self::MICROS;
    public const MAX_PRICE_MICROS = 1_000 * self::MICROS;
    /** A period's spending is capped here (MAX_SPENT_* in libs/core): far beyond every limit. */
    public const MAX_SPENT_TOKENS = 1_000_000_000_000_000;
    public const MAX_SPENT_MICROS = 100_000_000_000_000_000;

    public function __construct(
        public UsageFormat $usage,
        public QuotaPeriod $period,
        /** The highest output cap (`max_tokens` & co.) a request within the budget may ask for. */
        public int $maxOutputTokens,
        public ?int $tokens,
        public ?Cost $cost,
    ) {}

    /** "2.50" → 2_500_000; null for anything that is not a plain decimal amount (parseAmount()). */
    public static function amount(mixed $text): ?int
    {
        if (!\is_string($text) || preg_match('/^(0|[1-9][0-9]{0,8})(?:\.([0-9]{1,6}))?$/D', $text, $match) !== 1) {
            return null;
        }

        return (int) $match[1] * self::MICROS + (int) str_pad($match[2] ?? '', 6, '0');
    }

    /**
     * What one answer costs: tokens, and micros rounded up (0 without a cost). Fits in 64 bits:
     * at most 2 × 10^9 tokens × 10^9 micros per million.
     *
     * @return array{int, int}
     */
    public function charge(Usage $usage): array
    {
        if ($this->cost === null) {
            return [$usage->input + $usage->output, 0];
        }
        $total = $usage->input * $this->cost->inputMicrosPerMillion + $usage->output * $this->cost->outputMicrosPerMillion;

        return [$usage->input + $usage->output, intdiv($total + self::MICROS - 1, self::MICROS)];
    }

    /** True once the period's spending has reached the token or the cost limit. */
    public function exhausted(int $tokens, int $micros): bool
    {
        return ($this->tokens !== null && $tokens >= $this->tokens) || ($this->cost !== null && $micros >= $this->cost->limitMicros);
    }
}
