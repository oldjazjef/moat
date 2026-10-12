<?php

declare(strict_types=1);

namespace Moat\Gate\Upstream;

/** What the cURL callbacks collect during one upstream call. */
final class Received
{
    public string $body = '';
    public bool $tooLarge = false;
    public int $headerBytes = 0;
    public ?string $contentType = null;
}
