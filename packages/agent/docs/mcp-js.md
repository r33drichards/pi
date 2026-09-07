# Native mcp-js execution environment (experimental)

This page describes the existing prototype. See [Direct native filesystem design](mcp-js-design.md)
for the proposed replacement and the verified upstream dependency state as of 2026-09-07.

The harness can use JavaScript instead of Bash without changing the file tool
schemas. `FileToolContext` requires only `FileSystem`; `JavaScriptRuntime` is a
separate execution capability, not a reinterpretation of `Shell.exec`.

## Native prerequisite

The companion checkout `/tmp/mcp-js-runtime-inspect` contains a change against
mcp-js revision `299a26df`: `Engine.create_with_filesystem(memory, timeout,
filesystem_policy_json)`. After regenerating the UniFFI Node bindings, this is
`Engine.createWithFilesystem`. It takes a single operation policy object:

```json
{"policies": [{"url": "file:///absolute/path/filesystem.rego"}]}
```

An empty policy list is rejected. The constructor enables policy-gated host
filesystem access only: no subprocess, network, or module-import configuration.
The native library and generated bindings must be built using the companion
repository's `node/README.md` instructions. They are not published as a portable
npm dependency. The Rust change and generated binding compatibility have not
been verified by a native build in this workspace.

## Harness configuration

Import `Engine` from your generated bindings using a top-level import. Then:

```ts
import {
  BACKGROUND_CONTEXT,
  createEditTool,
  createReadTool,
  createRunJsTool,
  createWriteTool,
  McpJsExecutionEnv,
} from "@earendil-works/pi-agent-core/node";

const engine = Engine.createWithFilesystem(64n, 30n, JSON.stringify({
  policies: [{ url: "file:///absolute/path/filesystem.rego" }],
}));
const env = new McpJsExecutionEnv(engine, "/work");

const toolOptions = {
  tools: [createReadTool(), createWriteTool(), createEditTool(), createRunJsTool()],
  toolContext: { env },
};
// Pass toolOptions into your AgentHarness creation options.
// When the harness is finished:
await env.cleanup(BACKGROUND_CONTEXT);
```

Do not register `createBashTool()` in this configuration. This does not change
the separate coding-agent CLI's default registration.

Use absolute guest paths, for example:

```js
await fs.writeFile("/work/notes.txt", "hello");
console.log(await fs.readFile("/work/notes.txt", "utf8"));
```

`cwd` resolves file-tool paths; it does not change the native process cwd.
The file tools normalize paths and serialize their arguments as JSON, never as
executable source fragments. They perform no Node filesystem I/O. Policy
denials are returned to the model, not retried against a local backend.

The engine must be exclusively owned by the adapter. Calls are serialized;
cleanup waits for queued work and releases the native handle. Guest heaps are
stateless, while host files persist across calls. This is not a snapshot/overlay
filesystem configuration or an OS sandbox. Policies must address traversal,
symlinks, and every relevant operation; `run_js` can pass raw paths directly to
`fs.*`. The adapter's path normalization is not a security boundary.

## Current limitations

- No generated binding or native execution proof yet; unit tests use a mock
  native API and test adapter behavior only.
- Cancellation prevents queued calls from starting but does not interrupt an
  in-flight call. The call settles before cancellation is reported, and effects
  may already have happened. Native timeouts still apply.
- Console output is collected by the native blocking tool API before tool-side
  truncation. No source-side bounded streaming or durable progress checkpoints.
- File contents cross the JSON console channel. Large files are buffered and
  binary reads use byte arrays, which increase transfer size.
- `readTextLines` reads the full file before slicing.
- Canonical paths, exclusive temporary files/directories, and binary append
  return `not_supported`; native `fs` lacks the required operations. Symlink
  aliases therefore do not share canonical mutation queue keys.
- Filesystem errors are mapped from native error messages; a typed native error
  channel is needed for a stable long-term contract.

The companion `node/tests/filesystem.test.ts` checks real filesystem access,
cross-call persistence, and policy denial once bindings are generated. Run it
alongside `tests/engine.test.ts` in the native build environment before use.
