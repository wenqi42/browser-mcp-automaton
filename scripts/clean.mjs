import { rm } from "node:fs/promises";

for (const path of [
  "packages/shared/dist",
  "packages/mcp-server/dist",
  "packages/extension/dist"
]) {
  await rm(path, { recursive: true, force: true });
  console.log(`Removed ${path}`);
}
