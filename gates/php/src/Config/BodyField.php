<?php

declare(strict_types=1);

namespace Moat\Gate\Config;

/**
 * One field of a route's `body` (FR-13), as libs/core/src/http/body.ts describes it. Only the
 * members of its type are set; the others keep their defaults.
 */
final readonly class BodyField
{
    /**
     * @param list<string>|null $enum allowed string values; null = any
     * @param array<string, BodyField> $fields the fields of an object
     */
    public function __construct(
        public BodyFieldType $type,
        public bool $required = false,
        public ?int $minLength = null,
        public ?int $maxLength = null,
        public ?array $enum = null,
        public bool $email = false,
        public ?int $minimum = null,
        public ?int $maximum = null,
        public array $fields = [],
        public ?BodyField $items = null,
        public ?int $minItems = null,
        public int $maxItems = 0,
    ) {}
}
