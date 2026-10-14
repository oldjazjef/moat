<?php

declare(strict_types=1);

namespace Moat\Gate\Http;

use Moat\Gate\Config\BodyField;
use Moat\Gate\Config\BodyFieldType;
use Moat\Gate\Config\BodySchema;
use Moat\Gate\Json\Canonical;
use Moat\Gate\Json\JsonObject;
use Moat\Gate\Json\StrictJson;
use Moat\Gate\Rejection;
use Moat\Gate\RejectionCode;

/**
 * FR-13, as validateBody() in libs/core/src/http/body.ts (conformance/vectors/http/body.json):
 * the body is parsed as strict JSON, must be an object, keeps only the route's fields at every
 * level and is forwarded as canonical JSON. A missing required field, a wrong type, a value
 * outside its bounds, enum or format, or null anywhere → `body_invalid`.
 */
final class BodyValidator
{
    /** `format: email`, the pattern EMAIL of libs/core (`\z`: no trailing newline). */
    private const EMAIL = '/^[A-Za-z0-9!#$%&\'*+\/=?^_`{|}~.-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}\z/';
    private const MAX_EMAIL_LENGTH = 254;

    /** @param array<string, BodyField> $fields */
    public static function validate(array $fields, string $bytes): string
    {
        try {
            $value = StrictJson::decode($bytes);
        } catch (Rejection) {
            self::fail();
        }
        if (!$value instanceof JsonObject) {
            self::fail();
        }

        return Canonical::encode(self::keep($fields, $value));
    }

    /** @param array<string, BodyField> $fields */
    private static function keep(array $fields, JsonObject $value): JsonObject
    {
        $kept = [];
        foreach ($fields as $name => $field) {
            if (!$value->has($name)) {
                if ($field->required) {
                    self::fail();
                }
                continue;
            }
            $kept[$name] = self::check($field, $value->get($name));
        }

        return new JsonObject($kept);
    }

    private static function check(BodyField $field, mixed $value): mixed
    {
        return match ($field->type) {
            BodyFieldType::String => self::string($field, $value),
            BodyFieldType::Integer => self::integer($field, $value),
            BodyFieldType::Boolean => \is_bool($value) ? $value : self::fail(),
            BodyFieldType::Object => $value instanceof JsonObject ? self::keep($field->fields, $value) : self::fail(),
            BodyFieldType::Array => self::items($field, $value),
        };
    }

    private static function string(BodyField $field, mixed $value): string
    {
        if (!\is_string($value)) {
            self::fail();
        }
        $length = BodySchema::length($value);
        if (
            ($field->minLength !== null && $length < $field->minLength)
            || ($field->maxLength !== null && $length > $field->maxLength)
            || ($field->enum !== null && !\in_array($value, $field->enum, true))
            || ($field->email && (\strlen($value) > self::MAX_EMAIL_LENGTH || preg_match(self::EMAIL, $value) !== 1))
        ) {
            self::fail();
        }

        return $value;
    }

    private static function integer(BodyField $field, mixed $value): int
    {
        if (
            !\is_int($value)
            || ($field->minimum !== null && $value < $field->minimum)
            || ($field->maximum !== null && $value > $field->maximum)
        ) {
            self::fail();
        }

        return $value;
    }

    /** @return list<mixed> */
    private static function items(BodyField $field, mixed $value): array
    {
        $items = $field->items;
        if (
            !\is_array($value) || !array_is_list($value) || $items === null
            || ($field->minItems !== null && \count($value) < $field->minItems)
            || \count($value) > $field->maxItems
        ) {
            self::fail();
        }

        return array_map(static fn(mixed $item): mixed => self::check($items, $item), $value);
    }

    private static function fail(): never
    {
        throw new Rejection(RejectionCode::BodyInvalid);
    }
}
