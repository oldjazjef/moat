<?php

declare(strict_types=1);

namespace Moat\Gate\Config;

use Moat\Gate\Json\JsonObject;
use Moat\Gate\Rejection;
use Moat\Gate\RejectionCode;

/**
 * A route's `body` in the compiled config (FR-13), checked exactly as bodyFieldsSchema and
 * bodySchemaProblem() in libs/core/src/http/body.ts (conformance/vectors/config/config.json):
 * strict keys per type, ASCII field names, 1 to 64 fields per object, at most 256 fields and 4
 * nested levels in all, minimum ≤ maximum, no `required` on array items. Else `config_invalid`.
 */
final class BodySchema
{
    public const FIELD_NAME = '/^[A-Za-z_][A-Za-z0-9_]{0,63}$/D';
    public const MAX_FIELDS = 256;
    public const MAX_OBJECT_FIELDS = 64;
    public const MAX_DEPTH = 4;
    public const MAX_STRING_LENGTH = 1_000_000;
    public const MAX_ENUM_VALUES = 64;
    public const MAX_ENUM_LENGTH = 256;
    public const MAX_ARRAY_ITEMS = 1_000;
    public const MAX_INTEGER = 9007199254740991;

    /** @return array<string, BodyField> */
    public static function parse(mixed $value): array
    {
        $count = 0;

        return self::fields($value, 0, $count);
    }

    /** @return array<string, BodyField> */
    private static function fields(mixed $value, int $depth, int &$count): array
    {
        if (!$value instanceof JsonObject) {
            self::fail();
        }
        // keys(), not the members' array keys: PHP turns a key such as "1" into an integer.
        $names = $value->keys();
        if ($names === [] || \count($names) > self::MAX_OBJECT_FIELDS) {
            self::fail();
        }
        $fields = [];
        foreach ($names as $name) {
            if (preg_match(self::FIELD_NAME, $name) !== 1 || $name === '__proto__') {
                self::fail();
            }
            $fields[$name] = self::field($value->get($name), $depth, false, $count);
        }

        return $fields;
    }

    private static function field(mixed $value, int $depth, bool $item, int &$count): BodyField
    {
        if (!$value instanceof JsonObject) {
            self::fail();
        }
        $type = \is_string($value->get('type')) ? BodyFieldType::tryFrom($value->get('type')) : null;
        if ($type === null) {
            self::fail();
        }
        if (++$count > self::MAX_FIELDS) {
            self::fail();
        }
        $required = $value->has('required') ? $value->get('required') : false;
        if (!\is_bool($required) || ($item && $value->has('required'))) {
            self::fail();
        }
        $optional = static fn(string ...$keys): array => array_values(array_filter($keys, $value->has(...)));

        return match ($type) {
            BodyFieldType::String => self::string($value, $required, $optional('required', 'minLength', 'maxLength', 'enum', 'format')),
            BodyFieldType::Integer => self::integer($value, $required, $optional('required', 'minimum', 'maximum')),
            BodyFieldType::Boolean => self::boolean($value, $required, $optional('required')),
            BodyFieldType::Object => self::object($value, $required, $optional('required'), self::deeper($depth), $count),
            BodyFieldType::Array => self::array($value, $required, $optional('required', 'minItems'), self::deeper($depth), $count),
        };
    }

    /** @param list<string> $optional */
    private static function string(JsonObject $value, bool $required, array $optional): BodyField
    {
        self::exactKeys($value, 'type', ...$optional);
        $minLength = self::optionalInt($value, 'minLength', 0, self::MAX_STRING_LENGTH);
        $maxLength = self::optionalInt($value, 'maxLength', 0, self::MAX_STRING_LENGTH);
        if ($minLength !== null && $maxLength !== null && $minLength > $maxLength) {
            self::fail();
        }
        if ($value->has('format') && $value->get('format') !== 'email') {
            self::fail();
        }

        return new BodyField(BodyFieldType::String, $required, $minLength, $maxLength, $value->has('enum') ? self::enum($value->get('enum')) : null, $value->has('format'));
    }

    /** @param list<string> $optional */
    private static function boolean(JsonObject $value, bool $required, array $optional): BodyField
    {
        self::exactKeys($value, 'type', ...$optional);

        return new BodyField(BodyFieldType::Boolean, $required);
    }

    /** @param list<string> $optional */
    private static function object(JsonObject $value, bool $required, array $optional, int $depth, int &$count): BodyField
    {
        self::exactKeys($value, 'type', 'fields', ...$optional);

        return new BodyField(BodyFieldType::Object, $required, fields: self::fields($value->get('fields'), $depth, $count));
    }

    /** @param list<string> $optional */
    private static function integer(JsonObject $value, bool $required, array $optional): BodyField
    {
        self::exactKeys($value, 'type', ...$optional);
        $minimum = self::optionalInt($value, 'minimum', 0, self::MAX_INTEGER);
        $maximum = self::optionalInt($value, 'maximum', 0, self::MAX_INTEGER);
        if ($minimum !== null && $maximum !== null && $minimum > $maximum) {
            self::fail();
        }

        return new BodyField(BodyFieldType::Integer, $required, minimum: $minimum, maximum: $maximum);
    }

    /** @param list<string> $optional */
    private static function array(JsonObject $value, bool $required, array $optional, int $depth, int &$count): BodyField
    {
        self::exactKeys($value, 'type', 'items', 'maxItems', ...$optional);
        $minItems = self::optionalInt($value, 'minItems', 0, self::MAX_ARRAY_ITEMS);
        $maxItems = $value->get('maxItems');
        if (!\is_int($maxItems) || !ConfigValidator::intIn($maxItems, 1, self::MAX_ARRAY_ITEMS) || ($minItems !== null && $minItems > $maxItems)) {
            self::fail();
        }

        return new BodyField(BodyFieldType::Array, $required, items: self::field($value->get('items'), $depth, true, $count), minItems: $minItems, maxItems: $maxItems);
    }

    /** One level further down; objects and arrays nest at most MAX_DEPTH levels. */
    private static function deeper(int $depth): int
    {
        return $depth + 1 > self::MAX_DEPTH ? self::fail() : $depth + 1;
    }

    /** @return list<string> */
    private static function enum(mixed $value): array
    {
        if (!\is_array($value) || !array_is_list($value) || $value === [] || \count($value) > self::MAX_ENUM_VALUES) {
            self::fail();
        }
        $values = [];
        foreach ($value as $entry) {
            if (!\is_string($entry) || self::length($entry) > self::MAX_ENUM_LENGTH) {
                self::fail();
            }
            $values[] = $entry;
        }

        return $values;
    }

    /** Unicode code points of a valid UTF-8 string (StrictJson guarantees it): bytes minus continuation bytes. */
    public static function length(string $value): int
    {
        return \strlen($value) - (int) preg_match_all('/[\x80-\xBF]/', $value);
    }

    private static function optionalInt(JsonObject $value, string $key, int $min, int $max): ?int
    {
        if (!$value->has($key)) {
            return null;
        }
        $number = $value->get($key);
        if (!\is_int($number) || !ConfigValidator::intIn($number, $min, $max)) {
            self::fail();
        }

        return $number;
    }

    private static function exactKeys(JsonObject $value, string ...$keys): void
    {
        if (!$value->hasExactKeys(...$keys)) {
            self::fail();
        }
    }

    private static function fail(): never
    {
        throw new Rejection(RejectionCode::ConfigInvalid);
    }
}
