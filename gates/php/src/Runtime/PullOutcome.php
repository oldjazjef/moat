<?php

declare(strict_types=1);

namespace Moat\Gate\Runtime;

/** How a lazy pull (DT-11) ended; anything but Accepted leaves the active bundle as it was. */
enum PullOutcome: string
{
    /** A new, higher version passed every check of `accept` and is active now. */
    case Accepted = 'accepted';
    /** The file is the active bundle, byte for byte. */
    case Unchanged = 'unchanged';
    /** The file is a bundle, but a check of `accept` failed (the record names it). */
    case Rejected = 'rejected';
    /** The place answered with a status other than 200. */
    case HttpStatus = 'http_status';
    /** No usable answer: unreachable, timeout, redirect, too large or a forbidden address. */
    case Failed = 'failed';
}
