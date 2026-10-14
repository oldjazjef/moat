<?php

declare(strict_types=1);

namespace Moat\Gate\Json;

/**
 * RFC 8785 (JCS) for what StrictJson decodes: null, booleans, integers from 0 to 2^53 − 1,
 * strings, lists and JsonObject — the same text as canonicalJson() in libs/core
 * (conformance/vectors/http/body.json), for objects whose keys are ASCII, as body field names are
 * (BodySchema::FIELD_NAME): byte order is then RFC 8785's UTF-16 order. json_encode escapes strings
 * exactly as JSON.stringify does once slashes, Unicode and line terminators are left as they are.
 */
final class Canonical
{
    private const FLAGS = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_LINE_TERMINATORS | JSON_THROW_ON_ERROR;

    public static function encode(mixed $value): string
    {
        if ($value instanceof JsonObject) {
            $members = $value->members();
            $keys = array_map(strval(...), array_keys($members));
            foreach ($keys as $key) {
                if (preg_match('/^[\x00-\x7F]*$/D', $key) !== 1) {
                    throw new \InvalidArgumentException('Canonical: ASCII keys only');
                }
            }
            sort($keys, SORT_STRING);
            $parts = [];
            foreach ($keys as $key) {
                $parts[] = json_encode($key, self::FLAGS) . ':' . self::encode($members[$key]);
            }

            return '{' . implode(',', $parts) . '}';
        }
        if (\is_array($value)) {
            return '[' . implode(',', array_map(self::encode(...), $value)) . ']';
        }
        if ($value === null || \is_bool($value) || \is_string($value) || (\is_int($value) && $value >= 0)) {
            return json_encode($value, self::FLAGS);
        }

        throw new \InvalidArgumentException('Canonical: not a strict JSON value');
    }
}
