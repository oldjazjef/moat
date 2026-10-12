<?php

declare(strict_types=1);

namespace Moat\Gate\Config;

/** The validated `config` of a bundle: what the gate enforces. */
final readonly class CompiledConfig
{
    /**
     * @param array<string, Upstream> $upstreams by name
     * @param array<string, Route>    $routes    by name
     * @param bool                    $enabled   false = locked (the gate or its environment): every
     *                                           request is refused with `gate_disabled`
     */
    public function __construct(
        public array $upstreams,
        public array $routes,
        public bool $enabled = true,
    ) {}

    public function upstreamOf(Route $route): Upstream
    {
        // validate() guarantees the reference.
        return $this->upstreams[$route->upstream];
    }
}
