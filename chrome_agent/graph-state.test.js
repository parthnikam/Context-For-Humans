import assert from "node:assert/strict";
import { moveConversation, renameProject } from "./graph-state.js";

const projects = [
  {
    id: "p1",
    name: "Old name",
    links: [
      { title: "Conversation A", url: "https://example.test/a" },
      { title: "Conversation B", url: "https://example.test/b" },
    ],
  },
  {
    id: "p2",
    name: "Other project",
    links: [{ title: "Conversation C", url: "https://example.test/c" }],
  },
];

const renamed = renameProject(projects, "p1", "New name");
assert.equal(renamed[0].name, "New name");
assert.equal(projects[0].name, "Old name");
assert.throws(() => renameProject(projects, "p1", "  "), /cannot be empty/);

const moved = moveConversation(projects, "p1", "p2", "https://example.test/a");
assert.deepEqual(moved[0].links.map((link) => link.url), ["https://example.test/b"]);
assert.deepEqual(moved[1].links.map((link) => link.url), [
  "https://example.test/c",
  "https://example.test/a",
]);
assert.equal(projects[0].links.length, 2);
assert.throws(
  () => moveConversation(projects, "p1", "p2", "https://example.test/missing"),
  /no longer belongs/,
);
assert.equal(moveConversation(projects, "p1", "p1", "https://example.test/a"), projects);

console.log("Graph rename and conversation reassignment checks passed.");
