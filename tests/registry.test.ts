// Registry: adapter isolation (AC3 — replacing one adapter never affects the
// others), writeManaged safety semantics, shim probe order, dispatch.
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { installAll, makeContext, uninstallAll, which } from "../src/framework/registry.ts";
import type { InstallContext, TargetAdapter, TargetResult } from "../src/framework/registry.ts";
import { manifest } from "../src/plugin/manifest.ts";

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "aps-reg-"));
  mkdirSync(d, { recursive: true });
  return d;
}

function ctx(dir: string, opts: { dryRun?: boolean } = {}): InstallContext {
  return makeContext(manifest, { scope: "project", dir, dryRun: opts.dryRun, home: tmpDir() });
}

function adapter(id: string, behavior: { file?: string; throws?: boolean }): TargetAdapter {
  return {
    id,
    kind: "native",
    label: `Agent ${id}`,
    scope: "project",
    detect: async () => false,
    install: async (c) => {
      if (behavior.throws) throw new Error(`boom from ${id}`);
      if (behavior.file) {
        c.writeManaged(behavior.file, `managed by ${id} (${id}:managed)`, `${id}:managed`);
      }
      return { status: "ok", detail: `${id} installed` };
    },
    uninstall: async (c): Promise<TargetResult> => {
      if (behavior.throws) throw new Error(`boom uninstall ${id}`);
      if (behavior.file) {
        const content = readFileSync(join(c.dir, behavior.file), "utf8");
        if (content.includes(`${id}:managed`)) {
          const { rmSync } = await import("node:fs");
          rmSync(join(c.dir, behavior.file));
        }
      }
      return { status: "ok" };
    },
  };
}

test("installAll: one adapter throwing does not block the others (AC3)", async () => {
  const dir = tmpDir();
  const out = await installAll(
    [adapter("a", { throws: true }), adapter("b", { file: "b.txt" }), adapter("c", { file: "c.txt" })],
    ctx(dir),
  );
  const byId = new Map(out.map((o) => [o.id, o.result]));
  assert.equal(byId.get("a")?.status, "error");
  assert.ok(String(byId.get("a")?.detail).includes("boom from a"));
  assert.equal(byId.get("b")?.status, "ok");
  assert.equal(byId.get("c")?.status, "ok");
  assert.equal(readFileSync(join(dir, "b.txt"), "utf8"), "managed by b (b:managed)"); // b's work landed
});

test("replacing one adapter leaves the others' behavior unchanged (AC3)", async () => {
  const dir = tmpDir();
  const base = [adapter("a", { file: "a.txt" }), adapter("b", { file: "b.txt" })];
  await installAll(base, ctx(dir));

  // Replace b with a broken implementation, keep a.
  const replaced = [adapter("a", { file: "a.txt" }), adapter("b", { throws: true })];
  const out = await installAll(replaced, ctx(dir));
  assert.equal(out.find((o) => o.id === "a")?.result.status, "ok");
  assert.equal(out.find((o) => o.id === "b")?.result.status, "error");
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "managed by a (a:managed)"); // untouched by b's failure
});

test("writeManaged: new file created; marked file backed up + replaced; user file untouched", () => {
  const dir = tmpDir();
  const c = ctx(dir);

  // 1. new file
  c.writeManaged("new.txt", "v1 <m1>", "m1");
  assert.equal(readFileSync(join(dir, "new.txt"), "utf8"), "v1 <m1>");

  // 2. marked file → replaced with backup (content carries the marker)
  c.writeManaged("new.txt", "v2 <m1>", "m1");
  assert.equal(readFileSync(join(dir, "new.txt"), "utf8"), "v2 <m1>");
  assert.equal(readFileSync(join(dir, "new.txt.bak"), "utf8"), "v1 <m1>");

  // 3. user-authored file without our marker → never touched
  writeFileSync(join(dir, "user.txt"), "user content");
  const r = c.writeManaged("user.txt", "hijacked", "m1");
  assert.equal(r.changed, false);
  assert.equal(readFileSync(join(dir, "user.txt"), "utf8"), "user content");
});

test("writeManaged: idempotent — same content writes nothing, no extra backup", () => {
  const dir = tmpDir();
  const c = ctx(dir);
  c.writeManaged("idem.txt", "same <m1>", "m1");
  c.writeManaged("idem.txt", "same <m1>", "m1");
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".bak")).length, 0);
});

test("dry-run writeManaged reports but writes nothing", () => {
  const dir = tmpDir();
  const c = ctx(dir, { dryRun: true });
  const r = c.writeManaged("dry.txt", "x", "m1");
  assert.equal(r.changed, true);
  assert.equal(existsSync(join(dir, "dry.txt")), false);
});

test("uninstallAll also isolates failures", async () => {
  const dir = tmpDir();
  const c = ctx(dir);
  await installAll([adapter("a", { file: "a.txt" }), adapter("b", { file: "b.txt" })], c);
  const out = await uninstallAll([adapter("a", { throws: true }), adapter("b", { file: "b.txt" })], c);
  assert.equal(out.find((o) => o.id === "a")?.result.status, "error");
  assert.equal(out.find((o) => o.id === "b")?.result.status, "ok");
  assert.equal(existsSync(join(dir, "b.txt")), false); // b's cleanup still ran
});

test("which: shim probe order is .exe → .cmd → .bat → extensionless LAST", () => {
  const dir = tmpDir();
  writeFileSync(join(dir, "tool.exe"), "");
  writeFileSync(join(dir, "tool.cmd"), "");
  writeFileSync(join(dir, "tool"), ""); // extensionless
  const p = which("tool", [dir]);
  assert.ok(p, "found on PATH");
  assert.ok(p.endsWith("tool.exe"), `.exe must win over extensionless, got: ${p}`);
  assert.equal(which("nope", [dir]), null);
});
