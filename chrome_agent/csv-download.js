export function createCsvDownload(conversations) {
  if (!conversations.length) return;
  const escapeCsv = (value) => {
    const text = String(value);
    const safeText = /^[\u0000-\u0020]*[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${safeText.replace(/"/g, '""')}"`;
  };
  const rows = [
    ["title", "url"],
    ...conversations.map(({ title, url }) => [title, url]),
  ];
  const csv = `\uFEFF${rows.map((row) => row.map(escapeCsv).join(",")).join("\r\n")}`;
  const blobUrl = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = blobUrl;
  anchor.download = `conversations-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}
