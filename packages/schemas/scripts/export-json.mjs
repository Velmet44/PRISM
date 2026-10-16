import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import { CapabilityRecord } from "../dist/policy.js";
import { Checkpoint, WorkspaceManifest } from "../dist/checkpoints.js";
import { ProtocolError } from "../dist/errors.js";
import {
  EventEnvelope,
  ResyncRequired,
  SnapshotRow,
} from "../dist/events.js";
import {
  ApprovalSigDoc,
  ProofDoc,
  Tier5AssertionDoc,
  WsRedemptionDoc,
  WsTicketIssuance,
} from "../dist/auth.js";
import { SupportManifest } from "../dist/support-manifest.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "generated");
mkdirSync(outDir, { recursive: true });

const targets = {
  "event-envelope": EventEnvelope,
  "resync-required": ResyncRequired,
  "snapshot-row": SnapshotRow,
  "proof-doc": ProofDoc,
  "ws-ticket-issuance": WsTicketIssuance,
  "ws-redemption-doc": WsRedemptionDoc,
  "approval-sig-doc": ApprovalSigDoc,
  "tier5-assertion-doc": Tier5AssertionDoc,
  "capability-record": CapabilityRecord,
  checkpoint: Checkpoint,
  "workspace-manifest": WorkspaceManifest,
  "protocol-error": ProtocolError,
  "support-manifest": SupportManifest,
};

for (const [name, schema] of Object.entries(targets)) {
  writeFileSync(
    join(outDir, `${name}.schema.json`),
    `${JSON.stringify(zodToJsonSchema(schema, name), null, 2)}\n`,
  );
}
console.log(`exported ${Object.keys(targets).length} schemas to generated/`);
