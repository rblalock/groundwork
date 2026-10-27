// Blocks a build when a string from a local, untracked deny list appears in the tree.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const listFile = join(root, ".plans", "forbidden-words.txt");
if (!existsSync(listFile)) process.exit(0);

const words = readFileSync(listFile, "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)
  .map((word) => word.toLowerCase());
if (words.length === 0) process.exit(0);

const SKIP = new Set(["node_modules", ".git", ".plans", ".next", ".eve", ".output"]);

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.isFile()) yield path;
  }
}

/** Every file a commit could pick up: git's tracked and unignored files, else the whole tree. */
function candidates() {
  const git = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" });
  if (git.status === 0) return git.stdout.split("\0").filter((rel) => rel && !SKIP.has(rel.split("/")[0]) && existsSync(join(root, rel)));
  return [...files(root)].map((path) => relative(root, path));
}

let hits = 0;
for (const rel of candidates()) {
  const path = join(root, rel);
  const lowerPath = rel.toLowerCase();
  for (const word of words) {
    if (lowerPath.includes(word)) {
      console.log(`${rel}: path contains a listed string`);
      hits++;
    }
  }
  const text = readFileSync(path);
  if (text.includes(0)) continue;
  const lines = text.toString("utf8").split("\n");
  lines.forEach((line, index) => {
    const lower = line.toLowerCase();
    if (words.some((word) => lower.includes(word))) {
      console.log(`${rel}:${index + 1}`);
      hits++;
    }
  });
}
process.exit(hits ? 1 : 0);
