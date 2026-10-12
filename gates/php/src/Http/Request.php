<?php

declare(strict_types=1);

namespace Moat\Gate\Http;

use Moat\Gate\Storage\Files;

/**
 * What the gate takes from a client request — and nothing else: method, raw path, content type,
 * declared length and (on demand, with a limit) the body. No client header, cookie or query
 * parameter is ever forwarded (SEC-43).
 */
final readonly class Request
{
    /** @param \Closure(int): string $body reads at most n + 1 bytes */
    public function __construct(
        public string $method,
        public ?string $rawPath,
        public ?string $contentType,
        public ?int $contentLength,
        private \Closure $body,
    ) {}

    /**
     * The route path is what follows the gate's script name in the raw request URI
     * (`/moat-gate.php/newsletter` → `/newsletter`), before any decoding; null if there is none.
     *
     * @param array<mixed> $server $_SERVER
     */
    public static function fromServer(array $server): self
    {
        $uri = \is_string($server['REQUEST_URI'] ?? null) ? $server['REQUEST_URI'] : '';
        $script = \is_string($server['SCRIPT_NAME'] ?? null) ? $server['SCRIPT_NAME'] : '';
        $path = explode('?', $uri, 2)[0];
        $rawPath = $script !== '' && str_starts_with($path, $script . '/') ? substr($path, \strlen($script)) : null;
        $length = \is_string($server['CONTENT_LENGTH'] ?? null) ? $server['CONTENT_LENGTH'] : '';

        return new self(
            \is_string($server['REQUEST_METHOD'] ?? null) ? $server['REQUEST_METHOD'] : '',
            $rawPath,
            \is_string($server['CONTENT_TYPE'] ?? null) && $server['CONTENT_TYPE'] !== '' ? $server['CONTENT_TYPE'] : null,
            preg_match('/^[0-9]{1,15}$/D', $length) === 1 ? (int) $length : null,
            Files::readInput(...),
        );
    }

    /** The body, or a 413 once it exceeds `$maxBytes` — whatever Content-Length claimed. */
    public function body(int $maxBytes): string
    {
        if ($this->contentLength !== null && $this->contentLength > $maxBytes) {
            throw new Failure(GateError::BodyTooLarge);
        }
        $body = ($this->body)($maxBytes);
        if (\strlen($body) > $maxBytes) {
            throw new Failure(GateError::BodyTooLarge);
        }

        return $body;
    }
}
