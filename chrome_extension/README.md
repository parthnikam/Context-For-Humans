# Context For Humans

A Manifest V3 Chrome extension that scrolls a selected chat list or imports a CSV, classifies conversation titles into 134 broad categories with TypeSafe Jev, groups related titles inside each category with a persistent local ChromaDB vector index, and uses OpenAI to name the resulting projects. The graph displays the category -> project -> conversation hierarchy.

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked** and choose this `chrome_extension` folder. Use Chrome 114 or newer for the side-panel API. The extension requests access to all sites so it can scroll and read conversation links from any chat page; reload it in `chrome://extensions` after changing the manifest.
4. Open the chat page and select the extension toolbar button to open the side panel. If the extension was already installed, select **Reload** for it in `chrome://extensions` first.

## Start the local ChromaDB service

The extension cannot host an embedded Python database itself. From the repository root, install the companion service dependencies and start it:

```powershell
python -m pip install -r chroma_service/requirements.txt
python -m uvicorn chroma_service.app:app --host 127.0.0.1 --port 8760
```

Keep that terminal open while using the extension. The first indexing request may download ChromaDB's default sentence embedding model. Chroma persists its collection under `chroma_service/data/`; it remains available across extension reloads and CSV imports. The service binds only to localhost and accepts browser requests from Chrome extension origins.

## Configure TypeSafe, OpenAI, and Mem0

Put the API keys in `chrome_extension/.env`:

```text
TYPESAFE_API_KEY=your-typesafe-key
OPENAI_API_KEY=your-key
MEM0_API_KEY=your-mem0-key
```

`MEMO_API_KEY` is also accepted. Restart the local service after creating or changing `.env`. The service reads keys from its environment first and then from this file. Keys stay in the Python service; they are not stored in Chrome, sent by the extension, or written to the debug console. In **AI grouping settings**, select **Test service**, **Test Jev**, **Test OpenAI**, and **Test Mem0** to check the connections. Jev uses the `jev-latest` Choice model; OpenAI project naming and project answers use `gpt-5.6-luna`; Mem0 remembers filed projects so you can ask about them later. See [TypeSafe's Choice docs](https://docs.typesafe.ai/primitives/choice) for the classification primitive.

## Group conversations and tabs

The side panel has three tabs. **Conversations** holds the Ask bar at the top and the category browser below it. **Projects** is the tab home: press **Group my tabs** to cluster your open tabs into Chrome tab groups (auto-filed into your projects), then browse everything filed with the list/graph toggle — the same pattern as Conversations — plus your live Chrome URL tab groups below. **Import** holds the extraction tools, the AI grouping settings (service tests and similarity threshold), and the API debug console.

1. Start the local service, then open the **Import** tab and select **Test service**, **Test Jev**, **Test OpenAI**, and **Test Mem0**.
2. To extract from a chat page, select **Detect chat list**.
3. Choose the sidebar or list that contains the conversations. The selected area is outlined on the page.
4. Select **Extract & group**. The extension scrolls through the list, waits for lazy-loaded items, and groups collected link titles and URLs. It checks URLs against ChromaDB first and skips conversations that are already indexed. After three bottom nudges produce no new links, it stops. A new link resets the counter. Select **Cancel** to stop early.
5. Or select **Import title,url CSV** to group conversations from a CSV. The header must contain `title` and `url` columns; `conversation_title` is also accepted.
6. Browse the category list in **list view**, or select the graph icon in the toolbar for an interactive **graph view**: a live d3-force simulation of every category, project, and conversation, with vibrant per-category colors. Zoomed out only the categories are crisp; zoom in and the projects, then conversation links, pull into focus from a soft blur. Drag nodes and the physics re-settles; hover to highlight a neighborhood; click a node for details; double-click to open it; pan and scroll to zoom. Use the search field to filter category, project, and conversation text in either view.
7. Use **Ask** at the top of the Conversations tab to ask questions about your projects ("what was I working on with React?"). A `gpt-5.6-luna` agent decides which tools to call: `search_memory` (Mem0) and `search_conversations` (ChromaDB semantic search over filed titles). It answers only from what the tools find, links the source conversations under the answer, and replies "oops. i don't have that in my memory" when nothing matches. Filing or importing conversations stores each project in Mem0 automatically.
8. On the **Projects** tab, press **Group my tabs**. Tabs whose URLs match a filed project join that project's Chrome tab group; the rest are clustered into trails by `gpt-5.6-luna` (same grouping rules as the original Context For Humans tab grouper) and grouped in Chrome with a name and one-liner. The trails are then **auto-accepted**: each one is filed through the full conversation pipeline — Jev categorizes the links, ChromaDB clusters them, the project keeps the trail's name, and Mem0 remembers it — with no extra clicks. (If the filing pipeline fails, the trails fall back to suggestion cards you can Accept manually.) Click a filed project name to reopen its links in a Chrome tab group.
9. Below the projects browser, the **Chrome tab groups** section lists your live URL tab groups (with their color swatches) and any ungrouped tabs. The projects graph inside the Projects tab renders every filed project, its links, and any open suggestions in the live d3-force graph (vibrant colors, hover focus, drag, pan, zoom; suggestions appear as dashed rings). Double-click a project node to reopen its tabs. **Clear graphs** removes the saved graph and local index after confirmation. **View larger** opens the same category browser in a full browser tab. **Download CSV** exports the current conversation data.

Expand **API debug console** in the side panel to inspect local-service requests, ChromaDB clusters and category results, semantic search results, and OpenAI assignment payloads and responses. The service does not include API keys or authorization headers in these records. The console remains in memory only and is cleared when the panel closes.

Each title is first classified by TypeSafe Jev into one of the 134 fixed choices defined in `chroma_service/categories.py`. ChromaDB then groups similar titles only within the same category and retains category and project assignments in its persistent local collection. The cosine similarity threshold is adjustable from 0 to 1 in **AI grouping settings**; the default is `0.62`, and lower values create broader vector clusters. OpenAI receives each fixed cluster and its category, then either reuses a project in that exact category or creates a concise project name. It does not change category labels or cluster membership. The extension graph also saves the category on every project.

On first side-panel open after this redesign, a saved graph without category metadata is reclassified and rebuilt automatically. Keep both API keys configured and the local service running while that migration completes.

**Clear graphs** clears both the extension graph and the local ChromaDB collection after confirmation. The selected area's starting scroll position is restored after extraction. A 400-step limit prevents an endlessly loading page from running forever.

Each import or extraction is appended to the current graph. New links with URLs already present are skipped; a new group whose name matches an existing project is merged into that project.

Each conversation link shows its provider's logo beside the title in list view and in the detail panel: inline brand marks for OpenAI (chatgpt.com/openai.com), Claude (claude.ai/anthropic.com), and Gemini (gemini.google.com), and the site favicon (fetched from Google's favicon service) for any other provider; links without a reachable favicon show none.

The code is organized into folders by responsibility:

```text
chrome_extension/
  manifest.json          Extension manifest (paths point into the folders below)
  background/            Service worker that opens the side panel
  pages/                 Side panel and the larger graph page (HTML, CSS, JS)
  vendor/                Vendored open-source libraries (d3-force physics
                         engine and its quadtree/dispatch/timer deps)
  lib/                   Shared modules: local-service client (grouping.js),
                         list view + view toggle (graph-view.js),
                         force-directed canvas graph (graph-force.js),
                         tab grouping engine (tab-groups.js),
                         tab graph model (tab-graph-model.js),
                         detail panel (graph-detail.js), provider logos
                         (provider-logos.js), graph state/model, extraction,
                         page actions, CSV parsing and download
  tests/                 Node test files (run: node tests/<file>.js)

chroma_service/
  app.py                 FastAPI routes (thin) — run with uvicorn
  config.py              Paths, limits, model names, API-key loading
  models.py              Pydantic request models
  categories.py          The 134-category taxonomy sent to Jev
  typesafe_client.py     Jev Choice classification (batched, token-limit safe)
  openai_client.py       OpenAI project naming and reuse
  chroma_store.py        ChromaDB collection, clustering, search, persistence
  mem0_client.py         Mem0 Platform client (add and search project memories)
  qa.py                  /ask pipeline: Mem0 + ChromaDB context -> OpenAI answer
  pipeline.py            Categorize-then-cluster orchestration behind /cluster
  tests/                 Unit tests (run: python -m unittest discover -s chroma_service/tests -t .)
```

Page extraction reads links rendered as `<a href="...">` elements and does not open conversations or click page controls.
