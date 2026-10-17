import type { AuditRow } from '@moat/core';

export const EXPORT_FORMATS = ['json', 'csv'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

const COLUMNS = [
  'seq',
  'organisationId',
  'at',
  'actor',
  'action',
  'target',
  'details',
  'prevHash',
  'hash',
] as const;

/**
 * One CSV cell (RFC 4180). A cell that a spreadsheet would run as a formula (starts with `=`, `+`,
 * `-`, `@`, tab or CR) gets a leading apostrophe, so an export opened in Excel executes nothing.
 * Our own columns never start that way today; the guard keeps it true when a column changes.
 */
export function csvCell(value: string | number | null): string {
  let text = value === null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The CSV of an export: a header row, then one line per entry, `details` as its canonical JSON. */
export function auditCsv(rows: readonly AuditRow[]): string {
  const lines = [COLUMNS.join(',')];
  for (const row of rows)
    lines.push(COLUMNS.map((column) => csvCell(row[column])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
