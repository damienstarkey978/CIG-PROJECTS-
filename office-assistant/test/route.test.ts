import assert from "node:assert/strict";
import { test } from "node:test";
import { renderTemplate } from "../src/pipeline/alerts";
import { decideRoute } from "../src/pipeline/route";
import { score } from "../scripts/runEval";
import { classification } from "./helpers";

const route = (over = {}, known: any = null, confidenceThreshold = 0.7) =>
  decideRoute({ classification: classification(over), knownContactType: known, confidenceThreshold });

test("confident lead creates lead, callback task, follow up, alert", () => {
  const d = route();
  assert.equal(d.callerType, "lead");
  assert.equal(d.createLead, true);
  assert.equal(d.newContactType, "prospect");
  assert.equal(d.followUpTemplate, "lead_callback");
  assert.equal(d.alertOffice, true);
});

test("low confidence goes to a person, never to solicitor handling", () => {
  const d = route({ caller_type: "solicitor", confidence: 0.5 });
  assert.equal(d.callerType, "unknown");
  assert.equal(d.task?.type, "review_call");
});

test("solicitor: no task, no text, no alert", () => {
  const d = route({ caller_type: "solicitor", confidence: 0.95 });
  assert.deepEqual([d.task, d.followUpTemplate, d.alertOffice, d.newContactType], [null, null, false, "solicitor"]);
});

test("a number on file wins over the model, even at low confidence", () => {
  assert.equal(route({ caller_type: "lead", confidence: 0.3 }, "sub").callerType, "sub_vendor");
  assert.equal(route({ caller_type: "solicitor" }, "client").callerType, "existing_client");
  assert.equal(route({ caller_type: "lead", confidence: 0.3 }, "other").callerType, "unknown");
});

test("templates fill known fields and drop missing ones", () => {
  assert.equal(renderTemplate("Hi {first_name}, thanks for calling {company}.", { first_name: null, company: "WCI" }), "Hi , thanks for calling WCI.");
  assert.equal(renderTemplate("Hi {first_name}", { first_name: "Jane" }), "Hi Jane");
});

test("eval scoring counts accuracy and leads lost to solicitor", () => {
  const s = score([
    { label: "lead", routed: "lead" },
    { label: "lead", routed: "solicitor" },
    { label: "solicitor", routed: "solicitor" },
    { label: "sub_vendor", routed: "unknown" },
  ]);
  assert.equal(s.accuracy, 0.5);
  assert.equal(s.leadsLostToSolicitor, 1);
  assert.equal(s.perClass.lead.recall, 0.5);
  assert.equal(s.perClass.solicitor.precision, 0.5);
});
