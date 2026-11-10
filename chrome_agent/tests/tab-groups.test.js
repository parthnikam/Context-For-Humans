import assert from "node:assert/strict";
import {
  isUntitledTitle,
  mergeTrailGroups,
  projectGroups,
  pullUntitled,
  samePage,
  shouldSkipUrl,
} from "../lib/tab-groups.js";

assert.equal(samePage("https://a.test/x#one", "https://a.test/x#two"), true);
assert.equal(samePage("https://a.test/x", "https://a.test/y"), false);
assert.equal(samePage("", "https://a.test"), false);

assert.equal(shouldSkipUrl("chrome://extensions"), true);
assert.equal(shouldSkipUrl("https://chatgpt.com"), false);
assert.equal(shouldSkipUrl(""), true);

assert.equal(isUntitledTitle("New Tab"), true);
assert.equal(isUntitledTitle("Untitled document — Google Docs"), true);
assert.equal(isUntitledTitle("React hooks guide"), false);

const projects = [
  { id: "p1", name: "React work", links: [{ title: "React", url: "https://a.test/react" }] },
  { id: "p2", name: "Cooking", links: [] },
];
const tabs = [
  { id: 1, title: "React docs", url: "https://a.test/react#now" },
  { id: 2, title: "Python docs", url: "https://a.test/python" },
];
assert.deepEqual(projectGroups(projects, tabs), [{ title: "React work", tabIds: [1] }]);
assert.deepEqual(projectGroups(projects, []), []);

const untitled = pullUntitled([], [
  { id: 5, title: "New Tab" },
  { id: 6, title: "Untitled spreadsheet — Sheets" },
  { id: 7, title: "Real page" },
]);
assert.deepEqual(untitled, [{ title: "Untitled", tabIds: [5, 6] }]);

const merged = mergeTrailGroups(
  [{ title: "React work", tabIds: [1] }],
  [
    { label: "React work", tab_ids: [2, 3] },
    { label: "Cooking", tab_ids: [4, 1] },
  ],
);
assert.deepEqual(merged, [
  { title: "React work", tabIds: [1, 2, 3] },
  { title: "Cooking", tabIds: [4] },
]);

console.log("Tab grouping checks passed.");
