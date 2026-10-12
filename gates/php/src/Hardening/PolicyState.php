<?php

declare(strict_types=1);

namespace Moat\Gate\Hardening;

enum PolicyState: string
{
    case Missing = 'missing';
    case Installed = 'installed';
    case Testing = 'testing';
}
