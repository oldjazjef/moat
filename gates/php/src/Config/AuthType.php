<?php

declare(strict_types=1);

namespace Moat\Gate\Config;

/** How the gate adds an upstream's secret to the request (libs/core config/compiled.ts). */
enum AuthType: string
{
    case Bearer = 'bearer';
    case Header = 'header';
    case Query = 'query';
    /** FR-20: HTTP Basic, the secret as password. */
    case Basic = 'basic';
    /** FR-20: OAuth2 client credentials; the access token goes as a bearer token. */
    case OAuth2 = 'oauth2';
}
