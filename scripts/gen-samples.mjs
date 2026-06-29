// Generates sample .bpmn files from the engine so they carry real geometry.
// Run with: npx tsx scripts/gen-samples.mjs
import { writeFileSync } from "node:fs";
import { generateFromTextSync } from "../src/core/ai/index.ts";
import { exportBpmn } from "../src/core/xml/index.ts";

const samples = {
  "invoice-approval": `When an invoice is received, the accountant records it in the system.
The accountant checks the invoice against the purchase order.
If the documents are incomplete, send back to record the invoice.
The department head approves the invoice.
The system schedules the payment.
The process ends when the payment is archived.`,
  "permit-application": `The applicant submits a building permit application via the portal.
The clerk verifies the application for completeness.
If information is missing, return to the applicant for clarification.
The reviewer assesses the application against regulations.
The department head approves the permit.
The system issues the permit and the process ends.`,
  "customer-onboarding": `A new customer request is received by sales.
The sales agent collects the customer documents.
The compliance officer checks the documents for KYC.
If checks fail, send back to collect the documents again.
The manager approves the onboarding.
The system creates the customer account and the process completes.`,
};

for (const [name, text] of Object.entries(samples)) {
  const { model } = generateFromTextSync(text);
  writeFileSync(`samples/${name}.bpmn`, exportBpmn(model));
  console.log("wrote samples/" + name + ".bpmn");
}
