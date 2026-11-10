const PROVIDER_MARKS = [
  {
    name: "OpenAI",
    hosts: ["chatgpt.com", "chat.openai.com", "openai.com"],
    icon: "icons/openai.png",
  },
  {
    name: "Claude",
    hosts: ["claude.ai", "anthropic.com"],
    icon: "icons/claude.png",
  },
  {
    name: "Gemini",
    hosts: ["gemini.google.com", "bard.google.com", "aistudio.google.com"],
    icon: "icons/gemini.png",
  },
];
const PROVIDER_HOST_MAP = new Map();
for (const mark of PROVIDER_MARKS) {
  for (const host of mark.hosts) PROVIDER_HOST_MAP.set(host, mark);
}

function findProviderMark(host) {
  const exact = PROVIDER_HOST_MAP.get(host);
  if (exact) return exact;
  for (const [base, mark] of PROVIDER_HOST_MAP) {
    if (host.endsWith(`.${base}`)) return mark;
  }
  return null;
}

export function providerLogo(url) {
  let host = "";
  try {
    host = new URL(String(url || "").trim()).hostname;
  } catch {
    return null;
  }
  if (!host) return null;
  const logo = document.createElement("img");
  logo.className = "provider-logo";
  logo.alt = "";
  logo.loading = "lazy";
  logo.decoding = "async";
  logo.width = 16;
  logo.height = 16;
  const provider = findProviderMark(host);
  if (provider) {
    logo.title = provider.name;
    logo.src = chrome.runtime.getURL(provider.icon);
    return logo;
  }
  logo.title = host;
  logo.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`;
  logo.addEventListener("error", () => logo.remove());
  return logo;
}
