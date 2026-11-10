import assert from "node:assert/strict";
import {
  clearChromaIndex,
  groupConversations,
  syncProjectAssignments,
  testChromaService,
  testGeminiKey,
} from "./grouping.js";

const calls = [];
const debugRecords = [];
const incoming = [
  { title: "React hooks guide", url: "https://provider-a.test/1" },
  { title: "React hooks examples", url: "https://provider-b.test/2" },
  { title: "Weekend soup recipe", url: "https://provider-c.test/3" },
];
const existingProjects = [{
  id: "project-react",
  name: "React project",
  intent: "Build and learn React interfaces.",
  links: [
    { title: "React state patterns", url: "https://provider-old.test/1" },
    { title: "React component guide", url: "https://provider-old.test/2" },
  ],
}];

const fakeFetch = async (url, init = {}) => {
  const parsedUrl = new URL(url);
  const body = init.body ? JSON.parse(init.body) : {};
  calls.push({ url: parsedUrl, init, body });

  if (parsedUrl.pathname === "/health") {
    return jsonResponse({ ok: true, stored_titles: 25 });
  }
  if (parsedUrl.pathname === "/cluster") {
    return jsonResponse({
      indexed_titles: incoming.length,
      stored_titles: 28,
      similarity_threshold: body.similarity_threshold,
      clusters: [
        {
          cluster_id: "cluster-0",
          conversations: incoming.slice(0, 2),
          existing_project_candidates: [{
            project_id: "project-react",
            name: "React project",
            similarity: 0.81,
            matched_title: "React state patterns",
          }],
        },
        {
          cluster_id: "cluster-1",
          conversations: incoming.slice(2),
          existing_project_candidates: [],
        },
      ],
    });
  }
  if (parsedUrl.pathname === "/assign") {
    return jsonResponse({ updated: body.assignments.length });
  }
  if (parsedUrl.pathname === "/clear") {
    return jsonResponse({ cleared: true });
  }
  if (parsedUrl.pathname.includes(":generateContent")) {
    const prompt = body.contents[0].parts[0].text;
    if (!prompt.includes("Incoming fixed clusters and ChromaDB matches:")) {
      return jsonResponse({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });
    }
    assert.match(prompt, /React project/);
    assert.match(prompt, /React state patterns/);
    assert.match(prompt, /project-react/);
    assert.match(prompt, /Weekend soup recipe/);
    assert.doesNotMatch(prompt, /provider-a\.test/);
    return jsonResponse({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              assignments: [
                {
                  cluster_id: "incorrect-id",
                  existing_project_id: "project-react",
                  project_name: "",
                  intent: "",
                },
                {
                  cluster_id: "incorrect-id",
                  existing_project_id: "",
                  project_name: "Cooking",
                  intent: "Collect cooking and recipe conversations.",
                },
              ],
            }),
          }],
        },
      }],
    });
  }
  throw new Error(`Unexpected request: ${url}`);
};

assert.equal((await testChromaService({ fetch: fakeFetch })).stored_titles, 25);
assert.deepEqual(await testGeminiKey("gemini-test-key", { fetch: fakeFetch }), { ok: true });

const projects = await groupConversations({
  geminiApiKey: "gemini-test-key",
  conversations: incoming,
  existingProjects,
  similarityThreshold: 0.67,
  fetch: fakeFetch,
  onStatus: () => {},
  onDebug: (entry) => debugRecords.push(entry),
});

assert.deepEqual(projects.map((project) => project.id), ["project-react", "new:cluster-1"]);
assert.deepEqual(projects.map((project) => project.name), ["React project", "Cooking"]);
assert.deepEqual(projects.map((project) => project.links.map((link) => link.title)), [
  ["React hooks guide", "React hooks examples"],
  ["Weekend soup recipe"],
]);
const clusterRequest = calls.find((call) => call.url.pathname === "/cluster");
assert.equal(clusterRequest.body.similarity_threshold, 0.67);
const assignmentRequest = calls
  .filter((call) => call.url.pathname.includes(":generateContent"))
  .map((call) => JSON.parse(call.init.body).contents[0].parts[0].text)
  .find((prompt) => prompt.includes("Incoming fixed clusters and ChromaDB matches:"));
assert.match(assignmentRequest, /Existing projects and representative titles/);
assert.ok(debugRecords.some((entry) => entry.service === "ChromaDB" && entry.direction === "response"));
assert.ok(debugRecords.some((entry) => entry.service === "Gemini" && entry.direction === "request"));
assert.doesNotMatch(JSON.stringify(debugRecords), /gemini-test-key|x-goog-api-key/);

assert.deepEqual(await syncProjectAssignments([{
  title: "React hooks guide",
  url: incoming[0].url,
  project_id: "project-react",
  project_name: "React project",
}], { fetch: fakeFetch }), { updated: 1 });
assert.deepEqual(await clearChromaIndex({ fetch: fakeFetch }), { cleared: true });
assert.equal(calls.find((call) => call.url.pathname === "/assign").body.assignments.length, 1);

console.log("Persistent Chroma clustering and Gemma assignment checks passed.");

function jsonResponse(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
