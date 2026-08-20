/**
 * The prebuild workflows cannot be run here, so what is checked is the part
 * that can be: that they are valid YAML, that the helper matrix covers the same
 * distributions as the plugin matrix it was modelled on, and that the manifest
 * entry the build job writes carries exactly the fields
 * `desktopHelperInstall.ts` matches on. A field renamed on one side of that pair
 * and not the other is the failure mode this exists for — CI would stay green
 * and every user would be told their system is not covered.
 */
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const WORKFLOWS = fileURLToPath(new URL("../../../../../.github/workflows/", import.meta.url));
const HELPER_WORKFLOW = `${WORKFLOWS}desktop-helper-prebuilds.yml`;
const PLUGIN_WORKFLOW = `${WORKFLOWS}kwin-plugin-prebuilds.yml`;

const LOAD =
  "import json, sys, yaml; print(json.dumps([yaml.safe_load(open(p)) for p in sys.argv[1:]]))";

const hasPyYaml = spawnSync("python3", ["-c", "import yaml"], { encoding: "utf8" }).status === 0;

interface Matrix {
  readonly arch?: readonly string[];
  readonly distro?: readonly { readonly id: string; readonly image: string }[];
  readonly exclude?: readonly Record<string, unknown>[];
}

interface Workflow {
  readonly jobs?: Record<string, { readonly strategy?: { readonly matrix?: Matrix } }>;
}

function load(): readonly [Workflow, Workflow] {
  const result = spawnSync("python3", ["-c", LOAD, HELPER_WORKFLOW, PLUGIN_WORKFLOW], {
    encoding: "utf8",
  });
  // A YAML error is the whole point of this test, so it is the assertion rather
  // than a thrown parse failure with no context.
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as [Workflow, Workflow];
}

describe.skipIf(!hasPyYaml)("desktop-helper-prebuilds.yml", () => {
  it("is valid YAML with the build and assemble jobs the manifest needs", () => {
    const [helper] = load();

    expect(Object.keys(helper.jobs ?? {})).toEqual(["build", "assemble"]);
  });

  it("covers the same distributions and architectures as the KWin plugin matrix", () => {
    const [helper, plugin] = load();
    const matrix = (workflow: Workflow): Matrix =>
      workflow.jobs?.build?.strategy?.matrix ?? ({} as Matrix);

    const ids = (workflow: Workflow) =>
      (matrix(workflow).distro ?? []).map((entry) => entry.id).sort();
    expect(ids(helper)).toEqual(ids(plugin));
    expect(ids(helper)).toContain("arch");
    expect(matrix(helper).arch).toEqual(["x64", "arm64"]);
    // Arch publishes no official arm64 image, so both matrices drop that pair
    // rather than spending a runner on a job that cannot start.
    expect(JSON.stringify(matrix(helper).exclude)).toEqual(JSON.stringify(matrix(plugin).exclude));
  });

  it("writes every manifest field the runtime matches on", async () => {
    const text = await readFile(HELPER_WORKFLOW, "utf8");

    // The build job writes the identity; the assemble job adds the checksum
    // over the bytes that ship. Between them that is the whole entry
    // `readDesktopHelperManifest` accepts.
    for (const field of ["osId", "osVersionId", "arch", "glibc", "file", "builtOn"]) {
      expect(text).toContain(`"${field}":`);
    }
    expect(text).toContain('meta["sha256"]');
    // A file name, never a path: the runtime refuses an entry that escapes the
    // prebuilt root, so a workflow that wrote one would ship a dead build.
    expect(text).toContain('"file": "$name"');
  });
});
