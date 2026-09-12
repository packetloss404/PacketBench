import { mkdir, writeFile, rm } from "node:fs/promises";

const [mode, dataDir] = process.argv.slice(2);
if (!/^\.[a-zA-Z0-9_-]+$/.test(dataDir)) throw new Error("invalid fixture data dir");
const project = "/work/project";
await mkdir(`/root/${dataDir}`, { recursive: true });
await mkdir("/root/.claude", { recursive: true });
await rm("/root/probe-ran", { force: true });
await rm("/root/request-received", { force: true });
await writeFile(
  "/root/.claude/settings.json",
  JSON.stringify({
    mcpServers: { shared: { type: "http", url: "http://127.0.0.1:9/mcp" } },
  }),
);
await writeFile(
  `/root/${dataDir}/trusted-projects.json`,
  mode === "corrupt-trust"
    ? "{broken"
    : JSON.stringify({ version: 1, projects: mode === "untrusted" ? [] : [project] }),
);
const config = JSON.stringify({
  mcpServers: {
    shared: { disabled: true },
    project: {
      command: "/usr/local/bin/node",
      args: ["-e", "require('node:fs').writeFileSync('/root/probe-ran', 'ran')"],
    },
  },
});
await writeFile(`${project}/.mcp.json`, mode === "malformed" ? "{broken" : config);
await writeFile(`${project}/child/.mcp.json`, config);
await writeFile(
  "/opt/old-peer.cjs",
  `
console.log(JSON.stringify({type:'ready', protocolVersion:11}));
process.stdin.on('data', d => require('node:fs').appendFileSync('/root/request-received', d));
process.stdin.on('end', () => process.exit(0));
`,
);
await writeFile(
  "/opt/invalid-peer.cjs",
  `
console.log('invalid JSON');
process.stdin.on('data', d => require('node:fs').appendFileSync('/root/request-received', d));
process.stdin.on('end', () => process.exit(0));
`,
);
