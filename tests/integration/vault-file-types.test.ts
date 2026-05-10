import { afterEach, describe, expect, it } from "vitest";
import { utimesSync } from "node:fs";

import {
  bootstrapRuntimeAssets,
  cleanupWorkspace,
  createWorkspace,
  queryDb,
  runCliJson,
  updateWikiConfig,
  writeVaultFile,
} from "../helpers.js";

describe("vault file type filtering", () => {
  const workspaces: ReturnType<typeof createWorkspace>[] = [];

  afterEach(() => {
    while (workspaces.length > 0) {
      cleanupWorkspace(workspaces.pop()!);
    }
  });

  it("indexes only whitelisted file types by default", () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);

    writeVaultFile(workspace, "imports/paper.pdf", "paper");
    writeVaultFile(workspace, "imports/notes.txt", "notes");
    writeVaultFile(workspace, "config/settings.yaml", "flag: true");
    writeVaultFile(workspace, ".DS_Store", "ignored");
    writeVaultFile(workspace, "imports/Thumbs.db", "ignored");
    writeVaultFile(workspace, "imports/draft.swp", "ignored");

    runCliJson(["init"], workspace.env);

    const vaultFileIds = queryDb<{ id: string }>(workspace, "SELECT id FROM vault_files ORDER BY id").map((row) => row.id);
    const queueFileIds = queryDb<{ fileId: string }>(
      workspace,
      "SELECT file_id AS fileId FROM vault_processing_queue ORDER BY file_id",
    ).map((row) => row.fileId);

    expect(vaultFileIds).toEqual(["config/settings.yaml", "imports/notes.txt", "imports/paper.pdf"]);
    expect(queueFileIds).toEqual(vaultFileIds);
  });

  it("respects custom vaultFileTypes and removes files that fall out of the whitelist", () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);
    bootstrapRuntimeAssets(workspace);
    updateWikiConfig(workspace, (config) => {
      config.vaultFileTypes = ["pdf"];
    });

    writeVaultFile(workspace, "imports/paper.pdf", "paper");
    writeVaultFile(workspace, "imports/notes.txt", "notes");

    runCliJson(["init"], workspace.env);

    let vaultFileIds = queryDb<{ id: string }>(workspace, "SELECT id FROM vault_files ORDER BY id").map((row) => row.id);
    expect(vaultFileIds).toEqual(["imports/paper.pdf"]);

    updateWikiConfig(workspace, (config) => {
      config.vaultFileTypes = ["txt"];
    });

    runCliJson(["sync"], workspace.env);

    vaultFileIds = queryDb<{ id: string }>(workspace, "SELECT id FROM vault_files ORDER BY id").map((row) => row.id);
    const queueFileIds = queryDb<{ fileId: string }>(
      workspace,
      "SELECT file_id AS fileId FROM vault_processing_queue ORDER BY file_id",
    ).map((row) => row.fileId);

    expect(vaultFileIds).toEqual(["imports/notes.txt"]);
    expect(queueFileIds).toEqual(["imports/notes.txt"]);
  });

  it("infers and stores source timestamps from file names, paths, and mtime", () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);

    writeVaultFile(workspace, "imports/2024-03-05-retro.txt", "retro");
    writeVaultFile(workspace, "reports/2025-04-08/summary.txt", "summary");
    const plainPath = writeVaultFile(workspace, "imports/plain.txt", "plain");
    const mtime = new Date(2023, 6, 9, 10, 11, 12);
    utimesSync(plainPath, mtime, mtime);

    runCliJson(["init"], workspace.env);

    const rows = queryDb<{
      id: string;
      sourceTimestamp: string | null;
      sourceTimestampSource: string | null;
      sourceTimestampConfidence: number | null;
      sourceTimestampCandidates: string | null;
    }>(
      workspace,
      `
        SELECT
          id,
          source_timestamp AS sourceTimestamp,
          source_timestamp_source AS sourceTimestampSource,
          source_timestamp_confidence AS sourceTimestampConfidence,
          source_timestamp_candidates AS sourceTimestampCandidates
        FROM vault_files
        ORDER BY id
      `,
    );
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get("imports/2024-03-05-retro.txt")?.sourceTimestamp).toMatch(/^2024-03-05T00:00:00/);
    expect(byId.get("imports/2024-03-05-retro.txt")?.sourceTimestampSource).toBe("file_name");
    expect(byId.get("imports/2024-03-05-retro.txt")?.sourceTimestampConfidence).toBe(0.9);
    expect(byId.get("imports/2024-03-05-retro.txt")?.sourceTimestampCandidates).toContain("2024-03-05");

    expect(byId.get("reports/2025-04-08/summary.txt")?.sourceTimestamp).toMatch(/^2025-04-08T00:00:00/);
    expect(byId.get("reports/2025-04-08/summary.txt")?.sourceTimestampSource).toBe("path");
    expect(byId.get("reports/2025-04-08/summary.txt")?.sourceTimestampConfidence).toBe(0.8);

    expect(byId.get("imports/plain.txt")?.sourceTimestamp).toMatch(/^2023-07-09T10:11:12/);
    expect(byId.get("imports/plain.txt")?.sourceTimestampSource).toBe("file_mtime");
    expect(byId.get("imports/plain.txt")?.sourceTimestampConfidence).toBe(0.5);
  });
});
