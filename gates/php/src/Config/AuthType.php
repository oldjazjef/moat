<?php

declare(strict_types=1);

namespace Moat\Gate\Config;

/** How the gate adds an upstream's secret to the request (libs/core config/compiled.ts). */
enum AuthType: string
{
    case Bearer = 'bearer';
    case Header = 'header';
    case Query = 'query';
}
