<?php

declare(strict_types=1);

namespace Moat\Gate\Config;

/** FR-16: the closed list of JWT algorithms (no `none`, no shared-secret HS*). */
enum JwtAlg: string
{
    case EdDSA = 'EdDSA';
    case ES256 = 'ES256';
    case RS256 = 'RS256';
}
