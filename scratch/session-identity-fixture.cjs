"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/fixtures/session-identity-repair.ts
var session_identity_repair_exports = {};
__export(session_identity_repair_exports, {
  LEGACY_IDENTITY_ALIAS_ID: () => LEGACY_IDENTITY_ALIAS_ID,
  LEGACY_IDENTITY_ANSWER_ID: () => LEGACY_IDENTITY_ANSWER_ID,
  LEGACY_IDENTITY_INPUT_ID: () => LEGACY_IDENTITY_INPUT_ID,
  LEGACY_IDENTITY_REPEAT_ID: () => LEGACY_IDENTITY_REPEAT_ID,
  LEGACY_IDENTITY_SESSION_ID: () => LEGACY_IDENTITY_SESSION_ID,
  LEGACY_IDENTITY_SOURCE_ID: () => LEGACY_IDENTITY_SOURCE_ID,
  LEGACY_IDENTITY_TARGET_ID: () => LEGACY_IDENTITY_TARGET_ID,
  LEGACY_IDENTITY_TURN_ID: () => LEGACY_IDENTITY_TURN_ID,
  createLegacyIdentityLineage: () => createLegacyIdentityLineage,
  createRepeatedQueryIdentityLineage: () => createRepeatedQueryIdentityLineage,
  legacyIdentityDeliveryJournal: () => legacyIdentityDeliveryJournal
});
module.exports = __toCommonJS(session_identity_repair_exports);
var LEGACY_IDENTITY_SESSION_ID = "20260911_100157_8gbfe22d504b2f";
var LEGACY_IDENTITY_TURN_ID = "turn_c1408772fac54d06";
var LEGACY_IDENTITY_SOURCE_ID = "entry_fdb4f2769c49";
var LEGACY_IDENTITY_TARGET_ID = "entry_c49fccdba757";
var LEGACY_IDENTITY_ALIAS_ID = "entry_b04c17ada4dc";
var LEGACY_IDENTITY_ANSWER_ID = "entry_b45508931984";
var LEGACY_IDENTITY_REPEAT_ID = "entry_independent_repeat";
var LEGACY_IDENTITY_INPUT_ID = "input_mtwc19u7_a43e70f0";
var timestamp = "2026-09-11T02:24:03.231Z";
function entry(id, parentId, message) {
  return { type: "message", id, parentId, logicalId: id, timestamp, message: structuredClone(message) };
}
function createLegacyIdentityLineage(input = {}) {
  const sourceId = input.sourceEntryId ?? LEGACY_IDENTITY_SOURCE_ID;
  const targetId = input.targetEntryId ?? LEGACY_IDENTITY_TARGET_ID;
  const message = input.message ?? {
    role: "user",
    content: "ffmpeg query",
    turnId: LEGACY_IDENTITY_TURN_ID,
    timestamp
  };
  const prefix = entry("entry_shared_prefix", null, { role: "user", content: "Earlier request" });
  const shared = entry("entry_shared_reply", prefix.id, { role: "assistant", content: "Earlier answer" });
  const source = entry(sourceId, shared.id, message);
  const context = entry("entry_managed_context", shared.id, {
    role: "user",
    content: "=== Managed Run Context ===\n[redacted]",
    _synthetic: true,
    _source: "managed-run-context"
  });
  const target = entry(targetId, context.id, message);
  const alias = {
    ...entry(LEGACY_IDENTITY_ALIAS_ID, target.id, message),
    logicalId: target.id,
    sourceEntryId: target.id
  };
  const answer = entry(LEGACY_IDENTITY_ANSWER_ID, alias.id, {
    role: "assistant",
    content: "three animated clips answer",
    turnId: message.turnId,
    timestamp: "2026-09-11T02:34:30.458Z"
  });
  return { version: 2, entries: [prefix, shared, source, context, target, alias, answer], activeEntryId: answer.id };
}
function createRepeatedQueryIdentityLineage() {
  const lineage = createLegacyIdentityLineage();
  const source = lineage.entries.find((item) => item.id === LEGACY_IDENTITY_SOURCE_ID);
  if (source.type !== "message") throw new Error("Fixture source must be a message.");
  const repeated = entry(LEGACY_IDENTITY_REPEAT_ID, lineage.activeEntryId, source.message);
  return { ...lineage, entries: [...lineage.entries, repeated], activeEntryId: repeated.id };
}
function legacyIdentityDeliveryJournal() {
  return JSON.stringify({
    id: "evt_7556_b9d48627",
    seq: 7556,
    cursor: "fixture:7556",
    sessionId: LEGACY_IDENTITY_SESSION_ID,
    runId: "run_mtwbz5qa_f2e9922d",
    turnId: LEGACY_IDENTITY_TURN_ID,
    time: "2026-09-11T02:24:03.585Z",
    type: "run.input.delivered",
    payload: { inputs: [{
      inputId: LEGACY_IDENTITY_INPUT_ID,
      entryId: LEGACY_IDENTITY_SOURCE_ID,
      input: "ffmpeg query",
      deliveredAt: "2026-09-11T02:24:03.585Z"
    }] }
  }) + "\n";
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  LEGACY_IDENTITY_ALIAS_ID,
  LEGACY_IDENTITY_ANSWER_ID,
  LEGACY_IDENTITY_INPUT_ID,
  LEGACY_IDENTITY_REPEAT_ID,
  LEGACY_IDENTITY_SESSION_ID,
  LEGACY_IDENTITY_SOURCE_ID,
  LEGACY_IDENTITY_TARGET_ID,
  LEGACY_IDENTITY_TURN_ID,
  createLegacyIdentityLineage,
  createRepeatedQueryIdentityLineage,
  legacyIdentityDeliveryJournal
});
