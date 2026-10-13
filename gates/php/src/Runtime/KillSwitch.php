<?php

declare(strict_types=1);

namespace Moat\Gate\Runtime;

use Moat\Gate\Storage\DataDir;

/**
 * The local kill switch (SEC-15, FR-33, T-23; killSwitchOf() in libs/core): the data file `kill`,
 * written by `php moat-gate.php kill|revive` or by hand. It only ever switches things off and
 * needs neither the Cloud nor an endpoint on the gate (SEC-40). One entry per line, `gate` or
 * `route <name>`; blank lines and `#` comments are ignored. An unknown line, a file without the
 * data-file marker (an empty file uploaded over FTP) or one that cannot be read switches the
 * whole gate off (SEC-46).
 */
final readonly class KillSwitch
{
    public const FILE = 'kill';
    /** The lock `kill` and `revive` take; requests only read the file and never wait for it. */
    public const LOCK = 'killlock';
    private const ROUTE_LINE = '/^route ([a-z][a-z0-9-]{0,62})$/D';

    /** @param list<string> $routes sorted, once each */
    private function __construct(
        public bool $gate,
        public array $routes,
    ) {}

    public static function read(DataDir $data): self
    {
        try {
            $content = $data->read(self::FILE);
        } catch (\Throwable) {
            // Damaged or unreadable: whatever it was meant to switch off, switch off everything.
            return new self(true, []);
        }

        return $content === null ? new self(false, []) : self::parse($content);
    }

    public static function parse(string $content): self
    {
        $gate = false;
        $routes = [];
        foreach (explode("\n", $content) as $line) {
            $line = trim($line, " \t\r");
            if ($line === '' || str_starts_with($line, '#')) {
                continue;
            }
            if ($line === 'gate') {
                $gate = true;
            } elseif (preg_match(self::ROUTE_LINE, $line, $match) === 1) {
                $routes[] = $match[1];
            } else {
                return new self(true, []);
            }
        }

        return new self($gate, self::sorted($routes));
    }

    public function routeKilled(string $name): bool
    {
        return \in_array($name, $this->routes, true);
    }

    public function isOff(): bool
    {
        return !$this->gate && $this->routes === [];
    }

    /** The file's text after the marker, as `kill` and `revive` write it. */
    public function text(): string
    {
        $lines = ['# Local kill switch (SEC-15): written by php moat-gate.php kill|revive'];
        if ($this->gate) {
            $lines[] = 'gate';
        }
        foreach ($this->routes as $route) {
            $lines[] = 'route ' . $route;
        }

        return implode("\n", $lines) . "\n";
    }

    public function killGate(): self
    {
        return new self(true, $this->routes);
    }

    public function killRoute(string $route): self
    {
        return new self($this->gate, self::sorted([...$this->routes, $route]));
    }

    public function reviveRoute(string $route): self
    {
        return new self($this->gate, array_values(array_filter($this->routes, static fn(string $name): bool => $name !== $route)));
    }

    public static function validRouteName(string $name): bool
    {
        return preg_match(self::ROUTE_LINE, 'route ' . $name) === 1;
    }

    /**
     * @param list<string> $routes
     *
     * @return list<string>
     */
    private static function sorted(array $routes): array
    {
        $routes = array_values(array_unique($routes));
        sort($routes, SORT_STRING);

        return $routes;
    }
}
