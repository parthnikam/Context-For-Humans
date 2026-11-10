import assert from "node:assert/strict";
import {
  clusterBySimilarity,
  groupConversations,
  testGeminiKey,
  testMem0Key,
} from "./grouping.js";

assert.deepEqual(
  clusterBySimilarity(5, [
    [
      { sourceIndex: 0, targetIndex: 1, score: 0.8 },
      { sourceIndex: 1, targetIndex: 2, score: 0.7 },
    ],
    [{ sourceIndex: 3, targetIndex: 4, score: 0.9 }],
    [],
  ]),
  [[0, 1, 2], [3, 4]],
);

const conversations = [
  { title: "React project overview", url: "https://example.test/1" },
  { title: "React component design", url: "https://example.test/2" },
  { title: "Italian pasta recipe", url: "https://example.test/3" },
];
const indexed = [];
const calls = [];
const fakeFetch = async (url, init = {}) => {
  const parsedUrl = new URL(url);
  calls.push({ url: parsedUrl, init });
  if (parsedUrl.pathname === "/v1/ping/") return new Response("{}", { status: 200 });

  const body = init.body ? JSON.parse(init.body) : {};
  if (parsedUrl.pathname === "/v3/memories/add/") {
    indexed.push({
      title: body.messages[0].content,
      runId: body.run_id,
      userId: body.user_id,
      metadata: body.metadata,
      infer: body.infer,
    });
    return jsonResponse({ event_id: `event-${indexed.length}`, status: "SUCCEEDED" });
  }
  if (parsedUrl.pathname === "/v3/memories/search/") {
    const source = indexed.find((record) => record.title === body.query);
    const sourceIndex = source.metadata.conversation_index;
    const results = indexed
      .filter((record) => record.runId === body.filters.run_id && record.userId === body.filters.user_id)
      .map((record) => ({
        memory: record.title,
        metadata: record.metadata,
        score: (
          sourceIndex === record.metadata.conversation_index ||
          [sourceIndex, record.metadata.conversation_index].sort().join(",") === "0,1"
        ) ? 0.92 : 0.18,
      }))
      .filter((result) => result.score >= body.threshold);
    return jsonResponse({ results });
  }
  if (parsedUrl.pathname.includes(":generateContent")) {
    const prompt = body.contents[0].parts[0].text;
    if (!prompt.includes("Clusters (id and representative conversation titles):")) {
      return jsonResponse({
        candidates: [{ content: { parts: [{ text: "ok" }] } }],
      });
    }
    const clusters = JSON.parse(prompt.split("Clusters (id and representative conversation titles):\n")[1]);
    return jsonResponse({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              groups: clusters.map((cluster) => ({
                id: cluster.id,
                name: `Project ${cluster.id + 1}`,
                intent: cluster.titles[0],
              })),
            }),
          }],
        },
      }],
    });
  }
  throw new Error(`Unexpected request: ${url}`);
};

assert.deepEqual(await testMem0Key("mem0-test-key", { fetch: fakeFetch }), { ok: true });
assert.deepEqual(await testGeminiKey("gemini-test-key", { fetch: fakeFetch }), { ok: true });

const projects = await groupConversations({
  mem0ApiKey: "mem0-test-key",
  geminiApiKey: "gemini-test-key",
  conversations,
  fetch: fakeFetch,
  onStatus: () => {},
});

assert.equal(indexed.length, conversations.length);
assert.ok(indexed.every((record) => record.infer === false));
assert.ok(indexed.every((record) => record.runId === indexed[0].runId));
assert.ok(indexed.every((record) => record.userId === "conversation-exporter"));
assert.deepEqual(projects.map((project) => project.links.map((link) => link.title)), [
  ["React project overview", "React component design"],
  ["Italian pasta recipe"],
]);
assert.deepEqual(projects.map((project) => project.name), [
  "Project 1",
  "Italian pasta recipe",
]);

const searchRequests = calls.filter((call) => call.url.pathname === "/v3/memories/search/");
assert.equal(searchRequests.length, conversations.length);
assert.ok(searchRequests.every((call) => call.init.body));
assert.ok(searchRequests.every((call) => JSON.parse(call.init.body).threshold === 0.6));
const gemmaRequest = calls.find((call) =>
  call.url.pathname.includes(":generateContent") &&
  JSON.parse(call.init.body).contents[0].parts[0].text.includes(
    "Clusters (id and representative conversation titles):",
  )
);
const gemmaPrompt = JSON.parse(gemmaRequest.init.body).contents[0].parts[0].text;
assert.match(gemmaPrompt, /React project overview/);
assert.doesNotMatch(gemmaPrompt, /Italian pasta recipe/);
assert.doesNotMatch(gemmaPrompt, /https:\/\/example\.test/);

console.log("Mem0 similarity grouping and Gemma naming checks passed.");

function jsonResponse(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
