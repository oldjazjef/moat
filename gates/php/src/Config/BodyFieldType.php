<?php

declare(strict_types=1);

namespace Moat\Gate\Config;

/** The closed list of body field types (FR-13, BODY_FIELD_TYPES in libs/core). */
enum BodyFieldType: string
{
    case String = 'string';
    case Integer = 'integer';
    case Boolean = 'boolean';
    case Object = 'object';
    case Array = 'array';
}
