function csvCell(value) {
  let text = String(value ?? '');
  // Spreadsheet programs can execute a formula even after leading whitespace.
  if (/^\s*[=+@-]|^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
function encodeCsv(rows) {
  return '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}
function sendCsv(res, filename, rows) {
  res
    .set('Content-Disposition', `attachment; filename="${filename}"`)
    .type('text/csv; charset=utf-8')
    .send(encodeCsv(rows));
}
module.exports = { sendCsv, encodeCsv };
