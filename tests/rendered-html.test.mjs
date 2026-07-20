import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectFile = (path) => new URL(`../${path}`, import.meta.url);

test("ships as an MIT-licensed Wenshu Paper repository", async () => {
  const [packageText, readme, license] = await Promise.all([
    readFile(projectFile("package.json"), "utf8"),
    readFile(projectFile("README.md"), "utf8"),
    readFile(projectFile("LICENSE"), "utf8"),
  ]);
  const packageJson = JSON.parse(packageText);

  assert.equal(packageJson.name, "wenshu-paper-reader");
  assert.equal(packageJson.license, "MIT");
  assert.match(packageJson.repository.url, /github\.com\/kyre-99\/lumen-paper-reader/);
  assert.match(readme, /^# 文枢 Wenshu/m);
  assert.match(readme, /npm run local/);
  assert.match(license, /^MIT License/m);
});

test("keeps local data and credentials outside version control", async () => {
  const [gitignore, envExample] = await Promise.all([
    readFile(projectFile(".gitignore"), "utf8"),
    readFile(projectFile(".env.example"), "utf8"),
  ]);

  assert.match(gitignore, /^\.env\*/m);
  assert.match(gitignore, /^\/\.dev\.vars$/m);
  assert.match(gitignore, /^\/\.wrangler\/$/m);
  assert.doesNotMatch(envExample, /sk-[A-Za-z0-9_-]{16,}/);
  assert.doesNotMatch(envExample, /sb_publishable_[A-Za-z0-9_-]{12,}/);
});

test("includes precise PDF selection and persistent library state", async () => {
  const [page, schema] = await Promise.all([
    readFile(projectFile("app/page.tsx"), "utf8"),
    readFile(projectFile("db/schema.ts"), "utf8"),
  ]);

  assert.match(page, /function tightRangeClientRects\(/);
  assert.match(page, /className="selection-overlay-rect"/);
  assert.match(page, /function LibraryModal\(/);
  assert.match(page, /function MarkdownContent\(/);
  assert.match(schema, /sqliteTable\("paper_folders"/);
  assert.match(schema, /sqliteTable\("papers"/);
  assert.match(schema, /annotationsJson/);
  assert.match(schema, /messagesJson/);
});
