// Build script: bundles the CLI (ESM), the standalone hook (CJS, identity
// banner) and the dsh cordis plugin (ESM, @deepseek-ai/* external); injects
// the plugin-package identity files (plugin.json / mcp.json / .mcp.json /
// marketplace.json / cordis.patch.yml) from the manifest — the manifest is
// the SINGLE source of identity; these generated files are committed so the
// repo stays a valid plugin install source.
// Also syncs the skill copies (assets/SKILL.md → skills/<skillDir>/SKILL.md
// + references/) that git install sources must carry.
import { build } from "esbuild";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

/** Load the business manifest from TS (identity single source). */
async function loadManifest() {
  const result = await build({
    entryPoints: [join(root, "src/plugin/manifest.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    logLevel: "silent",
  });
  const code = result.outputFiles[0].text;
  const mod = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
  return mod.manifest;
}

/** Fill {{placeholder}} tokens (used by build for assets and by the generator). */
export function fillTemplate(body, vars) {
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`);
}

const manifest = await loadManifest();
const vars = {
  name: manifest.name,
  brand: manifest.brand,
  version: manifest.version,
  description: manifest.description,
  skillDir: manifest.markers.skillDir,
  commandFile: manifest.markers.commandFile,
  hook: manifest.markers.hook,
  configDir: manifest.markers.configDir,
};
const slug = manifest.githubSlug ?? "";
const homepage = slug ? `https://github.com/${slug}` : "";
const authorName = slug.split("/")[0] ?? "";
const keywords = [manifest.name, "mcp", "agent-plugins", "agent-skills", "scaffold"];

await mkdir(join(root, "dist"), { recursive: true });

await Promise.all([
  build({
    entryPoints: [join(root, "src/cli-entry.ts")],
    outfile: join(root, "dist/cli.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node18",
    // shebang comes from the source file; esbuild preserves it
    logLevel: "info",
  }),
  build({
    entryPoints: [join(root, "src/hook-entry.ts")],
    outfile: join(root, "dist/hook.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    // Legal-comment banner: preserved by esbuild; also serves as the
    // identity marker that the installer/uninstaller check.
    banner: { js: `/*! ${manifest.markers.hook} */` },
    logLevel: "info",
  }),
  // dsh cordis plugin. @deepseek-ai/* stay external: the dsh profile pnpm
  // closure injects them at runtime (devDependencies here for types only).
  // dist/dsh-plugin.js is committed to git (.gitignore exception) so
  // `dsh plugin add github:<slug>` works without a build step.
  build({
    entryPoints: [join(root, "src/plugin/dsh-plugin.ts")],
    outfile: join(root, "dist/dsh-plugin.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node18",
    external: ["@deepseek-ai/*"],
    logLevel: "info",
  }),
  // openclaw native plugin. openclaw/plugin-sdk stays external (host API);
  // typebox is bundled in — the materialized dir has no node_modules, so a
  // self-contained bundle is what makes `openclaw plugins install <dir>`
  // resolve imports (same philosophy as schemastery in dist/dsh-plugin.js).
  // dist/openclaw-plugin.js is copied to openclaw-dist/ (committed to git)
  // so the plugin dir is a complete install source from a git checkout.
  build({
    entryPoints: [join(root, "src/plugin/openclaw-plugin.ts")],
    outfile: join(root, "dist/openclaw-plugin.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node18",
    external: ["openclaw/plugin-sdk"],
    logLevel: "info",
  }),
]);

// ---------------------------------------------------------------- assets

await rm(join(root, "assets"), { recursive: true, force: true });
await cp(join(root, "src/assets"), join(root, "assets"), { recursive: true });

// Agent Plugins portable package: skills/<skillDir>/SKILL.md at the package
// root is the plugin copy of the skill (git-installed plugins ship it
// directly). Single source stays src/assets/SKILL.md (with {{placeholders}});
// this copy is the build-time fill + sync point and is committed to git.
const skillDir = join(root, "skills", manifest.markers.skillDir);
await mkdir(skillDir, { recursive: true });
const skillBody = fillTemplate(await readFile(join(root, "src/assets/SKILL.md"), "utf8"), vars);
await writeFile(join(skillDir, "SKILL.md"), skillBody, "utf8");

// Progressive disclosure (Agent Skills spec): if the skill references
// references/ files they must ship alongside. Copy the whole references dir.
if (existsSync(join(root, "src/assets/skill-references"))) {
  await mkdir(join(skillDir, "references"), { recursive: true });
  await cp(join(root, "src/assets/skill-references"), join(skillDir, "references"), { recursive: true });
}

// Companion skills (deviation #2): every src/assets/skills/<dir>/SKILL.md is
// synced to skills/<dir>/SKILL.md with the same {{placeholder}} filling.
const companionSkills = join(root, "src/assets/skills");
if (existsSync(companionSkills)) {
  for (const entry of await readdir(companionSkills, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const srcSkill = join(companionSkills, entry.name, "SKILL.md");
    if (!existsSync(srcSkill)) continue;
    const dstDir = join(root, "skills", entry.name);
    await mkdir(dstDir, { recursive: true });
    const body = fillTemplate(await readFile(srcSkill, "utf8"), vars);
    await writeFile(join(dstDir, "SKILL.md"), body, "utf8");
  }
}

// ---------------------------------------------------------------- identity files

const pluginJson = {
  $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  // agent-plugins 1.0.0 name pattern is [a-z0-9][a-z0-9.-]* — no npm scope.
  // brand is the unscoped product name; manifest.name stays the npm package id.
  name: manifest.brand,
  version: manifest.version,
  description: manifest.description,
  author: { name: authorName },
  homepage,
  repository: homepage,
  license: "MIT",
  keywords,
};
await writeFile(join(root, "plugin.json"), JSON.stringify(pluginJson, null, 2) + "\n", "utf8");

const mcpJson = {
  $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  mcpServers: {
    [manifest.name]: {
      type: "stdio",
      command: "npx",
      args: ["-y", manifest.name, "mcp"],
    },
  },
};
await writeFile(join(root, "mcp.json"), JSON.stringify(mcpJson, null, 2) + "\n", "utf8");
await cp(join(root, "mcp.json"), join(root, ".mcp.json"));

const marketplaceJson = {
  name: manifest.name,
  owner: { name: authorName },
  metadata: { description: manifest.description, version: manifest.version },
  plugins: [
    {
      // must match plugin.json's name (brand) so marketplace consumers can
      // resolve the entry; the marketplace's own top-level name stays the
      // npm package id.
      name: manifest.brand,
      source: ".",
      description: manifest.description,
      version: manifest.version,
      author: { name: authorName },
      homepage,
      repository: homepage,
      license: "MIT",
      keywords,
    },
  ],
};
await writeFile(join(root, "marketplace.json"), JSON.stringify(marketplaceJson, null, 2) + "\n", "utf8");

// dsh activation patch: id stays stable so re-installs replace, never duplicate.
// id = brand (unscoped cordis identifier, matching dsh's own patch convention);
// name = the npm package specifier cordis imports it by, so it keeps the scope
// and must stay quoted ('@' is a reserved YAML 1.1 scalar indicator).
const cordisPatch = `# dsh plugin activation - see package.json "dsh" key.\n- insert:\n    - id: ${manifest.brand}\n      name: "${manifest.name}"\n      config: {}\n`;
await writeFile(join(root, "cordis.patch.yml"), cordisPatch, "utf8");

// ---------------------------------------------------------------- openclaw

// OpenClaw plugin descriptor (same shape as the original openclaw package's
// openclaw.plugin.json). id = brand ('goal-acceptance') so upgrades replace
// the original plugin; contracts.tools derived from the manifest.
const openclawPluginJson = {
  id: manifest.brand,
  name: manifest.brand,
  description: manifest.description,
  version: manifest.version,
  configSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  activation: {
    onStartup: true,
  },
  contracts: {
    tools: manifest.tools.map((t) => t.name),
  },
};
await writeFile(join(root, "openclaw.plugin.json"), JSON.stringify(openclawPluginJson, null, 2) + "\n", "utf8");

// OpenClaw bundle distribution dir: the host resolves the plugin entry via
// the package.json "openclaw" key (extensions), same contract as the
// original npm package. Both files committed to git so the materialized
// plugin dir (which copies openclaw-dist/) is a complete install source.
await mkdir(join(root, "openclaw-dist"), { recursive: true });
await cp(join(root, "dist/openclaw-plugin.js"), join(root, "openclaw-dist/openclaw-plugin.js"));
await writeFile(
  join(root, "openclaw-dist/package.json"),
  JSON.stringify(
    {
      name: manifest.name,
      version: manifest.version,
      type: "module",
      main: "openclaw-plugin.js",
      openclaw: { extensions: ["./openclaw-plugin.js"] },
    },
    null,
    2,
  ) + "\n",
  "utf8",
);

// ---------------------------------------------------------------- generator

const generatorEntry = join(root, "src/generator/index.ts");
if (existsSync(generatorEntry)) {
  await build({
    entryPoints: [generatorEntry],
    outfile: join(root, "dist/generator.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node18",
    logLevel: "info",
  });
}

console.log(
  `build ok: dist/cli.js + dist/hook.cjs + dist/dsh-plugin.js + dist/openclaw-plugin.js + assets/ + ` +
    `skills/${manifest.markers.skillDir}/ + openclaw-dist/ + identity files injected (${manifest.name} v${manifest.version})`,
);
