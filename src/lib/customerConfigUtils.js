/** Customer has a linked config file on Drive (xlsx or Google Sheet). */
export function customerHasConfigFile(customer) {
  return Boolean(customer?.spreadsheetId || customer?.sourceFileId);
}

/** Customer config can be written via Google Sheets API (native sheet only). */
export function customerCanSyncToSheet(customer) {
  return Boolean(customer?.spreadsheetId);
}
