<?php

declare(strict_types=1);

namespace Moat\Gate\Http;

/** What the gate sends back: a status, its own fixed headers plus a content type, and a body. */
final readonly class Response
{
    /** @param array<string, string> $headers */
    public function __construct(
        public int $status,
        public array $headers,
        public string $body,
    ) {}

    /** @param array<string, string> $headers */
    public static function error(GateError $error, array $headers = []): self
    {
        return new self($error->status(), ['Content-Type' => 'application/json'] + $headers, json_encode(['error' => $error->value], JSON_THROW_ON_ERROR) . "\n");
    }

    public function send(): void
    {
        while (ob_get_level() > 0) {
            ob_end_clean();
        }
        header_remove();
        http_response_code($this->status);
        $headers = $this->headers + [
            'X-Content-Type-Options' => 'nosniff',
            'Cache-Control' => 'no-store',
            'Referrer-Policy' => 'no-referrer',
            'Content-Security-Policy' => "default-src 'none'; frame-ancestors 'none'; form-action 'none'; sandbox",
        ];
        foreach ($headers as $name => $value) {
            header($name . ': ' . $value);
        }
        echo $this->body;
    }
}
