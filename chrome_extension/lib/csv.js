export function parseConversationCsv(text) {
  const rows = parseRows(String(text || ""));
  while (rows.length && rows[0].every((cell) => !cell.trim())) rows.shift();
  if (!rows.length) throw new Error("The CSV is empty.");

  const header = rows.shift().map((cell) => cell.trim().replace(/^\uFEFF/, "").toLowerCase());
  const titleIndex = header.indexOf("title") >= 0 ? header.indexOf("title") : header.indexOf("conversation_title");
  const urlIndex = header.indexOf("url");
  if (titleIndex < 0 || urlIndex < 0) {
    throw new Error('CSV needs a header row with "title" and "url" columns.');
  }

  const unique = new Map();
  for (const [index, row] of rows.entries()) {
    const title = String(row[titleIndex] || "").trim();
    const url = String(row[urlIndex] || "").trim();
    if (!title && !url) continue;
    if (!title || !url) throw new Error(`CSV row ${index + 2} needs both a title and URL.`);
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`CSV row ${index + 2} has an invalid URL.`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`CSV row ${index + 2} must use an HTTP or HTTPS URL.`);
    }
    if (!unique.has(parsed.href)) unique.set(parsed.href, { title, url: parsed.href });
  }
  if (!unique.size) throw new Error("No conversation rows were found in the CSV.");
  if (unique.size > 2000) throw new Error("CSV contains more than 2,000 unique conversations.");
  return [...unique.values()];
}

function parseRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error("CSV has an unclosed quoted field.");
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
