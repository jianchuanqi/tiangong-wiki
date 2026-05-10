import Database from "better-sqlite3";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/core/config.js";
import { openDb } from "../../src/core/db.js";
import {
  bootstrapRuntimeAssets,
  cleanupWorkspace,
  createWorkspace,
  queryDb,
  runCli,
  workspaceDbPath,
  writeVaultFile,
} from "../helpers.js";

const WORKFLOW_COLUMNS = [
  "heartbeat_at",
  "processing_owner_id",
  "thread_id",
  "workflow_version",
  "decision",
  "result_manifest_path",
  "last_error_at",
  "last_error_code",
  "retry_after",
  "created_page_ids",
  "updated_page_ids",
  "applied_type_names",
  "proposed_type_names",
  "skills_used",
];

const VAULT_SOURCE_TIMESTAMP_COLUMNS = [
  "source_timestamp",
  "source_timestamp_source",
  "source_timestamp_confidence",
  "source_timestamp_candidates",
];

describe("queue schema workflow fields", () => {
  const workspaces: ReturnType<typeof createWorkspace>[] = [];

  afterEach(() => {
    while (workspaces.length > 0) {
      cleanupWorkspace(workspaces.pop()!);
    }
  });

  it("upgrades an existing queue table in place and keeps init/sync idempotent", () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);
    bootstrapRuntimeAssets(workspace);
    writeVaultFile(workspace, "imports/spec.pdf", "durable spec");

    const db = new Database(workspaceDbPath(workspace));
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS vault_processing_queue (
          file_id TEXT PRIMARY KEY,
          status TEXT DEFAULT 'pending',
          priority INTEGER DEFAULT 0,
          queued_at TEXT NOT NULL,
          processed_at TEXT,
          result_page_id TEXT,
          error_message TEXT,
          attempts INTEGER DEFAULT 0
        );
      `);
    } finally {
      db.close();
    }

    runCli(["init"], workspace.env);

    const columns = queryDb<{ name: string }>(workspace, "PRAGMA table_info(vault_processing_queue)");
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(WORKFLOW_COLUMNS));

    const syncAgain = JSON.parse(runCli(["sync"], workspace.env).stdout) as {
      inserted: number;
      updated: number;
      deleted: number;
    };
    expect(syncAgain).toMatchObject({
      inserted: 0,
      updated: 0,
      deleted: 0,
    });
  });

  it("upgrades an existing vault_files table before creating source timestamp indexes", () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);
    bootstrapRuntimeAssets(workspace);

    const db = new Database(workspaceDbPath(workspace));
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS vault_files (
          id TEXT PRIMARY KEY,
          file_name TEXT NOT NULL,
          file_ext TEXT,
          source_type TEXT,
          file_size INTEGER,
          file_path TEXT NOT NULL,
          content_hash TEXT,
          file_mtime REAL,
          indexed_at TEXT
        );
      `);
      db.prepare(
        `
          INSERT INTO vault_files(
            id, file_name, file_ext, source_type, file_size, file_path, content_hash, file_mtime, indexed_at
          )
          VALUES(@id, @fileName, @fileExt, @sourceType, @fileSize, @filePath, @contentHash, @fileMtime, @indexedAt)
        `,
      ).run({
        id: "imports/spec.pdf",
        fileName: "spec.pdf",
        fileExt: "pdf",
        sourceType: "local",
        fileSize: 12,
        filePath: "imports/spec.pdf",
        contentHash: "hash-before-migration",
        fileMtime: 1_765_000_000,
        indexedAt: "2026-05-10T12:00:00+08:00",
      });
    } finally {
      db.close();
    }

    const config = loadConfig(path.join(workspace.wikiRoot, "wiki.config.json"));
    const migrated = openDb(workspaceDbPath(workspace), config, 1536, undefined, { ensureFts: false });
    migrated.db.close();

    const columns = queryDb<{ name: string }>(workspace, "PRAGMA table_info(vault_files)");
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(VAULT_SOURCE_TIMESTAMP_COLUMNS));

    const indexes = queryDb<{ name: string }>(workspace, "PRAGMA index_list(vault_files)");
    expect(indexes.map((index) => index.name)).toContain("idx_vfiles_source_timestamp");

    const rows = queryDb<{
      id: string;
      contentHash: string;
      sourceTimestamp: string | null;
      sourceTimestampCandidates: string | null;
    }>(
      workspace,
      `
        SELECT
          id,
          content_hash AS contentHash,
          source_timestamp AS sourceTimestamp,
          source_timestamp_candidates AS sourceTimestampCandidates
        FROM vault_files
        WHERE id = ?
      `,
      ["imports/spec.pdf"],
    );
    expect(rows[0]).toEqual({
      id: "imports/spec.pdf",
      contentHash: "hash-before-migration",
      sourceTimestamp: null,
      sourceTimestampCandidates: null,
    });
  });

  it("persists workflow state columns on queue rows", () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);
    writeVaultFile(workspace, "imports/spec.pdf", "durable spec");

    runCli(["init"], workspace.env);

    const db = new Database(workspaceDbPath(workspace));
    try {
      db.prepare(
        `
          UPDATE vault_processing_queue
          SET
            thread_id = @threadId,
            heartbeat_at = @heartbeatAt,
            processing_owner_id = @processingOwnerId,
            workflow_version = @workflowVersion,
            decision = @decision,
            result_manifest_path = @resultManifestPath,
            last_error_at = @lastErrorAt,
            last_error_code = @lastErrorCode,
            retry_after = @retryAfter,
            created_page_ids = @createdPageIds,
            updated_page_ids = @updatedPageIds,
            applied_type_names = @appliedTypeNames,
            proposed_type_names = @proposedTypeNames,
            skills_used = @skillsUsed
          WHERE file_id = @fileId
        `,
      ).run({
        fileId: "imports/spec.pdf",
        threadId: "thread-123",
        heartbeatAt: "2026-04-07T12:01:00+08:00",
        processingOwnerId: "host:pid:123",
        workflowVersion: "2026-04-07",
        decision: "apply",
        resultManifestPath: "/tmp/result.json",
        lastErrorAt: "2026-04-07T12:00:00+08:00",
        lastErrorCode: "queue_full",
        retryAfter: "2026-04-07T12:05:00+08:00",
        createdPageIds: JSON.stringify(["concepts/spec.md"]),
        updatedPageIds: JSON.stringify(["methods/review.md"]),
        appliedTypeNames: JSON.stringify(["concept", "method"]),
        proposedTypeNames: JSON.stringify(["lab-report"]),
        skillsUsed: JSON.stringify(["tiangong-wiki-skill", "pdf"]),
      });
    } finally {
      db.close();
    }

    const rows = queryDb<Record<string, string | null>>(
      workspace,
      `
        SELECT
          thread_id AS threadId,
          heartbeat_at AS heartbeatAt,
          processing_owner_id AS processingOwnerId,
          workflow_version AS workflowVersion,
          decision,
          result_manifest_path AS resultManifestPath,
          last_error_code AS lastErrorCode,
          created_page_ids AS createdPageIds,
          updated_page_ids AS updatedPageIds,
          applied_type_names AS appliedTypeNames,
          proposed_type_names AS proposedTypeNames,
          skills_used AS skillsUsed
        FROM vault_processing_queue
        WHERE file_id = ?
      `,
      ["imports/spec.pdf"],
    );
    expect(rows[0]).toEqual({
      threadId: "thread-123",
      heartbeatAt: "2026-04-07T12:01:00+08:00",
      processingOwnerId: "host:pid:123",
      workflowVersion: "2026-04-07",
      decision: "apply",
      resultManifestPath: "/tmp/result.json",
      lastErrorCode: "queue_full",
      createdPageIds: '["concepts/spec.md"]',
      updatedPageIds: '["methods/review.md"]',
      appliedTypeNames: '["concept","method"]',
      proposedTypeNames: '["lab-report"]',
      skillsUsed: '["tiangong-wiki-skill","pdf"]',
    });
  });
});
