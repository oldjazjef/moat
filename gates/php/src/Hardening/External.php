<?php

declare(strict_types=1);

namespace Moat\Gate\Hardening;

/** The result of the check from outside (SEC-49: are the data files reachable?). */
enum External: string
{
    case NotChecked = 'not_checked';
    case Failed = 'failed';
    case NotGate = 'not_gate';
    case Blocked = 'blocked';
    case Reachable = 'reachable';
}
