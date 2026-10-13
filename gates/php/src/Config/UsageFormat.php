<?php

declare(strict_types=1);

namespace Moat\Gate\Config;

/**
 * Where an AI API's answer reports its usage (FR-31): a closed list, as readUsage() in libs/core
 * (conformance/vectors/http/budget.json). Config is data, never a path or an expression (SEC-20).
 */
enum UsageFormat: string
{
    case OpenAi = 'openai';
    case Anthropic = 'anthropic';
    case Gemini = 'gemini';

    public const MAX_TOKENS = 1_000_000_000;
    /** Answers nested deeper are not read (MAX_USAGE_DEPTH in libs/core). */
    public const MAX_DEPTH = 64;

    /**
     * The usage the answer's body reports, or null when it does not say (fail closed). The body
     * must be valid UTF-8 and valid JSON (no lone surrogate, at most MAX_DEPTH levels), but only the counted
     * fields are checked: floats and negative numbers elsewhere in an answer are fine. A count
     * written as `100.0` or `1e2` is 100, as in JavaScript.
     */
    public function read(string $body): ?Usage
    {
        try {
            // json_decode counts the scalar level too: depth 65 = 64 containers.
            // Arrays, not objects: a key PHP objects cannot hold (one starting with NUL) is fine in
            // JSON. A list has no named keys, so it reports no usage, as in libs/core.
            $decoded = json_decode($body, true, self::MAX_DEPTH + 1, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            return null;
        }
        $usage = \is_array($decoded) ? ($decoded[$this === self::Gemini ? 'usageMetadata' : 'usage'] ?? null) : null;
        if (!\is_array($usage)) {
            return null;
        }
        if ($this === self::OpenAi) {
            $responses = \array_key_exists('input_tokens', $usage);
            $input = self::count($usage, $responses ? 'input_tokens' : 'prompt_tokens');
            $output = self::count($usage, $responses ? 'output_tokens' : 'completion_tokens');
        } elseif ($this === self::Anthropic) {
            $input = self::sum(self::count($usage, 'input_tokens'), self::count($usage, 'cache_creation_input_tokens', true), self::count($usage, 'cache_read_input_tokens', true));
            $output = self::count($usage, 'output_tokens');
        } else {
            $input = self::sum(self::count($usage, 'promptTokenCount'), self::count($usage, 'toolUsePromptTokenCount', true));
            $output = self::sum(self::count($usage, 'candidatesTokenCount', true), self::count($usage, 'thoughtsTokenCount', true));
        }

        return $input === null || $output === null ? null : new Usage($input, $output);
    }

    /** An integer count from 0 to MAX_TOKENS; an optional one may be absent or null (= 0). */
    /**
     * What a request may cost at most (requestEstimate() in libs/core): its body's bytes as input
     * and the output cap it asks for, or null when it may not be forwarded within a budget — a
     * stream, more than one answer, no cap or one above `$maxOutput` (`request_unbounded`).
     */
    public function estimate(string $body, int $maxOutput): ?Usage
    {
        try {
            $request = json_decode($body, true, self::MAX_DEPTH + 1, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            return null;
        }
        if (!\is_array($request) || ($request !== [] && array_is_list($request)) || !\in_array($request['stream'] ?? null, [null, false], true)) {
            return null;
        }
        if ($this === self::OpenAi) {
            if (!self::single($request, 'n', $maxOutput)) {
                return null;
            }
            $output = null;
            foreach (['max_tokens', 'max_completion_tokens', 'max_output_tokens'] as $key) {
                if (($request[$key] ?? null) === null) {
                    continue;
                }
                $cap = self::cap($request[$key], $maxOutput);
                if ($cap === null) {
                    return null;
                }
                $output = max($output ?? 0, $cap);
            }
        } elseif ($this === self::Anthropic) {
            $output = self::cap($request['max_tokens'] ?? null, $maxOutput);
        } else {
            $config = $request['generationConfig'] ?? null;
            $output = \is_array($config) && self::single($config, 'candidateCount', $maxOutput)
                ? self::cap($config['maxOutputTokens'] ?? null, $maxOutput)
                : null;
        }

        return $output === null ? null : new Usage(\strlen($body), $output);
    }

    /** An output cap: an integer from 1 to `$max` (`100.0` is 100), else null. */
    private static function cap(mixed $value, int $max): ?int
    {
        if (\is_float($value) && is_finite($value) && floor($value) === $value) {
            $value = $value >= 1 && $value <= $max ? (int) $value : null;
        }

        return \is_int($value) && $value >= 1 && $value <= $max ? $value : null;
    }

    /**
     * `$key` absent, null or 1 (one answer, not several).
     *
     * @param array<mixed> $from
     */
    private static function single(array $from, string $key, int $max): bool
    {
        return ($from[$key] ?? null) === null || self::cap($from[$key], $max) === 1;
    }

    /** @param array<mixed> $usage */
    private static function count(array $usage, string $key, bool $optional = false): ?int
    {
        if (!\array_key_exists($key, $usage) || ($optional && $usage[$key] === null)) {
            return $optional ? 0 : null;
        }
        $value = $usage[$key];
        if (\is_float($value) && is_finite($value) && floor($value) === $value && $value >= 0 && $value <= self::MAX_TOKENS) {
            return (int) $value;
        }

        return \is_int($value) && $value >= 0 && $value <= self::MAX_TOKENS ? $value : null;
    }

    private static function sum(?int ...$parts): ?int
    {
        $total = 0;
        foreach ($parts as $part) {
            if ($part === null) {
                return null;
            }
            $total += $part;
        }

        return $total;
    }
}
