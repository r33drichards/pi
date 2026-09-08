# Native mcp-js execution environment (experimental)

The harness can use JavaScript instead of Bash without changing the file tool
schemas. `FileToolContext` requires only `FileSystem`; `JavaScriptRuntime` is a
separate execution capability, not a reinterpretation of `Shell.exec`.
[Direct native filesystem design](mcp-js-design.md) records the design and its
verification status.

## Native prerequisite

The companion [mcp-js](https://github.com/r33drichards/mcp-js) engine, from its
`claude/mcpjs-pi-integration-k1l3w7` branch onward, is configured with
builders and constructed with `Engine.create(config)`. Each configuration
record has a `<Record>Builder` whose `build()` throws
`RuntimeError.MissingRequiredField` for the first unset required field.
`filesystem` takes the `filesystem` entry of the server's `--policies-json`, so
`policies`, `pre` hooks, and `stack` layers behave exactly as they do for the
server; a configuration with no policies, pre hooks, or stack is rejected.

```ts
const config = new EngineConfigBuilder()
  .limits(new ExecutionLimitsBuilder().heapMemoryMaxMb(64n).executionTimeoutSecs(30n).build())
  .dataDir("/var/lib/pi/mcp-js")
  .filesystem(
    new FilesystemAccessBuilder()
      .policiesJson(JSON.stringify({ policies: [{ url: "file:///absolute/path/filesystem.rego" }] }))
      .build(),
  )
  .build();
const engine = Engine.create(config);
```

The axes are independent: `filesystem` enables hook-gated host filesystem
access for guest `fs.*` and the typed native file methods (`fsReadFile`,
`fsReadFileRange`, `fsReadTextFile`, `fsWriteFile`, `fsAppendFile`, `fsStat`,
`fsLstat`, `fsReadDir`, `fsCanonicalPath`, `fsMakeDir`, `fsRemove`, `fsRename`,
`fsExists`); `heapStore` enables V8 heap persistence between `run_js` calls;
`fsSnapshotStore` enables content-addressed filesystem snapshots. No
subprocess, network, or module-import configuration is exposed.
`Engine.createWithFilesystem(memory, timeout, filesystemJson)` remains as a
convenience for the filesystem-only case. Build the library and bindings with
the companion repository's `node/README.md` instructions; they are not a
published npm dependency.

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

const engine = Engine.create(config); // see the builder example above
const env = new McpJsExecutionEnv(engine, "/work");

const toolOptions = {
  tools: [createReadTool(), createWriteTool(), createEditTool(), createRunJsTool()],
  toolContext: { env },
};
// Pass toolOptions into your AgentHarness creation options.
// When the harness is finished:
await env.cleanup(BACKGROUND_CONTEXT);
```

Do not register `createBashTool()` in this configuration. The constructor
rejects engines whose `hostFilesystemEnabled()` is false.

Use absolute guest paths in `run_js`, for example:

```js
await fs.writeFile("/work/notes.txt", "hello");
console.log(await fs.readFile("/work/notes.txt", "utf8"));
```

`cwd` resolves file-tool paths; it does not change the native process cwd.

## What the adapter does

- File tools call the typed native methods directly. No JavaScript is generated
  or evaluated for file access, bytes cross the boundary as ArrayBuffers, and
  there is no Node filesystem fallback. Hook denials are returned to the model as
  `permission_denied`.
- `readTextLines` pages through the file with bounded native range reads
  (`MCP_JS_LINE_READ_CHUNK_BYTES` per call) and stops once `maxLines` lines are
  complete, decoding UTF-8 across chunk boundaries. `readTextFile` and
  `readBinaryFile` still return whole files; `edit` needs complete content.
- Errors map to `FileError` codes from the native message tokens
  (`nativeFileErrorCode`). Those tokens are the same ones the guest wrapper
  exposes as `err.code`, so the mapping does not depend on the generated
  binding's error class shape.
- Entry kinds come from the Unix mode bits in the native metadata, so symlink
  aliases now share canonical mutation-queue keys through `fsCanonicalPath`.
- `createTempDir` uses an exclusive non-recursive mkdir under `cwd`.
  `createTempFile` remains `not_supported`: the native API has no exclusive
  file creation.
- `run_js` calls are serialized; cleanup waits for queued JavaScript and for
  in-flight native file calls, then releases the native handle
  (`uniffiDestroy` is optional on the boundary because the generated
  constructor returns an `EngineLike`).

The engine must be exclusively owned by the adapter. Guest heaps are stateless,
while host files persist across calls. This is not a snapshot/overlay filesystem
configuration or an OS sandbox. Policies must address traversal, symlinks, and
every relevant operation; `run_js` can pass raw paths directly to `fs.*`. The
adapter's path normalization is not a security boundary.

## Coding agent opt-in

The experimental session worker chooses its tools from the environment it is
given: `createSessionWorkerTools(env)` returns read, write, and bash for an
environment with a shell, and read, write, and `run_js` for one that only runs
JavaScript. To run the coding agent's session worker on mcp-js, write an entry
module that imports your generated bindings and pass it as the worker's
`entryUrl` (`spawnInternalProcess` option). The experimental worker is not part
of the published package, so the entry lives in a checkout of this repository,
the way `packages/coding-agent/test/fixtures/faux-session-worker.ts` does:

```ts
import { McpJsExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createCodingAgentHarness, runSessionWorkerWithHarness } from "../src/experimental/session-worker.ts";
import { Engine } from "./generated/index";

void runSessionWorkerWithHarness(process.argv.slice(2), createCodingAgentHarness, async (cwd) => {
  const engine = Engine.createWithFilesystem(64n, 30n, JSON.stringify({
    policies: [{ url: "file:///absolute/path/filesystem.rego" }],
  }));
  return new McpJsExecutionEnv(engine, cwd);
});
```

The default entry keeps `NodeExecutionEnv` and bash. The session store uses
the same environment's filesystem, so the policy must allow the sessions root.

## Verification

- `test/harness/mcp-js.test.ts` checks adapter behavior against an in-memory
  engine with the native method shapes and error messages.
- mcp-js's `node/tests/filesystem.test.ts` checks the native methods against
  the generated bindings, including guest/native parity through a rewriting
  pre hook.
- mcp-js's `pi-harness-e2e` workflow checks this package's tools and
  `McpJsExecutionEnv` against the real shared library
  (`node/pi-harness/tests/harness.test.ts` there).

## Current limitations

- Cancellation prevents queued calls from starting but does not interrupt an
  in-flight call. The call settles before cancellation is reported, and effects
  may already have happened. Native timeouts still apply to JavaScript.
- `run_js` console output is collected by the native blocking tool API before
  tool-side truncation. No source-side bounded streaming or durable progress
  checkpoints.
- `readTextFile`, `readBinaryFile`, and `edit` load whole files.
- The adapter does not yet pass `heap`, `fs`, or `session` to `run_js`, so a
  heap-persistent engine still runs each call from a fresh heap; binding a pi
  session to a heap and a filesystem label is the next step.
- Overlay-backed (session snapshot) engines are not supported by the native
  file methods, so the adapter only works with host-backed engines.
