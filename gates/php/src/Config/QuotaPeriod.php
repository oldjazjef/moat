<?php

declare(strict_types=1);

namespace Moat\Gate\Config;

/** The calendar period of a quota (FR-31), in UTC. */
enum QuotaPeriod: string
{
    case Day = 'day';
    case Month = 'month';

    /** The first second after the day or month (UTC) that holds `$now`, as periodEnd() in libs/core. */
    public function end(int $now): int
    {
        if ($this === self::Day) {
            return (intdiv($now, 86_400) + 1) * 86_400;
        }
        $month = (int) gmdate('n', $now);
        $year = (int) gmdate('Y', $now);

        return $month === 12 ? (int) gmmktime(0, 0, 0, 1, 1, $year + 1) : (int) gmmktime(0, 0, 0, $month + 1, 1, $year);
    }
}
