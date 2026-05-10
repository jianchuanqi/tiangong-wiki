import path from "node:path";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { FakeCodexWorkflowRunner } from "../../src/core/codex-workflow.js";
import { processVaultQueueBatch } from "../../src/core/vault-processing.js";
import {
  cleanupWorkspace,
  createWorkspace,
  queryDb,
  runCli,
  runCliJson,
  writeVaultFile,
} from "../helpers.js";

describe("daemon workflow observability", () => {
  const workspaces: ReturnType<typeof createWorkspace>[] = [];

  afterEach(() => {
    while (workspaces.length > 0) {
      cleanupWorkspace(workspaces.pop()!);
    }
  });

  it("surfaces codex workflow state in queue output and daemon-style logs", async () => {
    const workspace = createWorkspace({
      WIKI_AGENT_ENABLED: "true",
      WIKI_AGENT_API_KEY: "test-agent-key",
      WIKI_AGENT_MODEL: "gpt-5.4",
      WIKI_AGENT_BACKEND: "codex-workflow",
      WIKI_AGENT_BATCH_SIZE: "10",
    });
    workspaces.push(workspace);

    writeVaultFile(workspace, "imports/evidence-review.pdf", "Durable evidence review workflow.");
    runCli(["init"], workspace.env);

    const logs: string[] = [];
    const extractedText = "Durable evidence review workflow extracted fulltext.\n";
    const extractedSha256 = createHash("sha256").update(extractedText, "utf8").digest("hex");
    const runner = new FakeCodexWorkflowRunner(({ threadId, input }) => {
      writeFileSync(input.extractedTextPath, extractedText, "utf8");
      return {
        status: "done",
        decision: "apply",
        reason: "Routed the source into the method ontology and proposed a new related type.",
        threadId,
        skillsUsed: ["tiangong-wiki-skill", "document-granular-decompose"],
        createdPageIds: ["methods/evidence-review.md"],
        updatedPageIds: ["concepts/evidence-ops.md"],
        appliedTypeNames: ["method", "concept"],
        proposedTypes: [
          {
            name: "evidence-brief",
            reason: "The corpus has recurring operational briefs that do not cleanly fit current types.",
            suggestedTemplateSections: ["## Summary", "## Evidence", "## Operational Guidance"],
          },
        ],
        actions: [
          {
            kind: "create_page",
            pageType: "method",
            pageId: "methods/evidence-review.md",
            title: "Evidence Review Workflow",
            summary: "Created a method page from the vault file.",
          },
          {
            kind: "update_page",
            pageType: "concept",
            pageId: "concepts/evidence-ops.md",
            summary: "Updated the existing concept with new evidence.",
          },
        ],
        lint: [
          { pageId: "methods/evidence-review.md", errors: 0, warnings: 0 },
          { pageId: "concepts/evidence-ops.md", errors: 0, warnings: 0 },
        ],
        extractedText: {
          path: input.extractedTextPath,
          parserSkill: "document-granular-decompose",
          sha256: extractedSha256,
          charCount: extractedText.length,
        },
      };
    });

    const processed = await processVaultQueueBatch(workspace.env, {
      workflowRunner: runner,
      log: (message) => logs.push(message),
    });

    expect(processed.done).toBe(1);
    expect(logs).toEqual(
      expect.arrayContaining([
        "claimed 1 items: imports/evidence-review.pdf",
        expect.stringContaining("imports/evidence-review.pdf: start processing"),
        expect.stringContaining("imports/evidence-review.pdf: launching workflow mode=start"),
        expect.stringContaining("imports/evidence-review.pdf: workflow started mode=start attempt=1/1 thread=fake-thread-1"),
        expect.stringContaining("imports/evidence-review.pdf: waiting for workflow result thread=fake-thread-1"),
        expect.stringContaining("imports/evidence-review.pdf: done thread=fake-thread-1"),
      ]),
    );
    const completionLog = logs.find((message) => message.includes("imports/evidence-review.pdf: done"));
    expect(completionLog).toContain("decision=apply");
    expect(completionLog).toContain("skills=tiangong-wiki-skill,document-granular-decompose");
    expect(completionLog).toContain("created=methods/evidence-review.md");
    expect(completionLog).toContain("updated=concepts/evidence-ops.md");
    expect(completionLog).toContain("proposed=evidence-brief");
    expect(completionLog).toContain("result=");

    const queue = runCliJson<{
      items: Array<{
        fileId: string;
        status: string;
        threadId: string | null;
        decision: string | null;
        resultManifestPath: string | null;
        skillsUsed: string[];
        createdPageIds: string[];
        updatedPageIds: string[];
        proposedTypeNames: string[];
        extractedTextPath: string | null;
        extractedTextSha256: string | null;
        extractedTextParserSkill: string | null;
        extractedTextCharCount: number | null;
      }>;
    }>(["vault", "queue"], workspace.env);

    expect(queue.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fileId: "imports/evidence-review.pdf",
          status: "done",
          threadId: "fake-thread-1",
          decision: "apply",
          skillsUsed: ["tiangong-wiki-skill", "document-granular-decompose"],
          createdPageIds: ["methods/evidence-review.md"],
          updatedPageIds: ["concepts/evidence-ops.md"],
          proposedTypeNames: ["evidence-brief"],
          extractedTextSha256: extractedSha256,
          extractedTextParserSkill: "document-granular-decompose",
          extractedTextCharCount: extractedText.length,
        }),
      ]),
    );

    const item = queue.items.find((entry) => entry.fileId === "imports/evidence-review.pdf");
    expect(item?.resultManifestPath).toContain(path.join("tiangong-wiki", ".queue-artifacts"));
    expect(item?.extractedTextPath).toContain("extracted-fulltext.txt");

    const extractionRows = queryDb<Record<string, string | number | null>>(
      workspace,
      `
        SELECT
          file_id AS fileId,
          artifact_path AS artifactPath,
          artifact_sha256 AS artifactSha256,
          parser_skill AS parserSkill,
          char_count AS charCount
        FROM vault_extractions
        WHERE file_id = ?
      `,
      ["imports/evidence-review.pdf"],
    );

    expect(extractionRows).toEqual([
      expect.objectContaining({
        fileId: "imports/evidence-review.pdf",
        artifactSha256: extractedSha256,
        parserSkill: "document-granular-decompose",
        charCount: extractedText.length,
      }),
    ]);
    expect(extractionRows[0]?.artifactPath).toContain("extracted-fulltext.txt");
  });
});
