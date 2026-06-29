# Sample AI prompts

Paste any of these into the **AI Modeling → Describe a process** box and click
**Generate BPMN draft**. They exercise roles, systems, decisions, approvals,
checks, exceptions and rework loops.

## 1. Invoice approval (free text + rework loop)
```
When an invoice is received, the accountant records it in the system.
The accountant checks the invoice against the purchase order.
If the documents are incomplete, send back to record the invoice.
The department head approves the invoice.
The system schedules the payment.
The process ends when the payment is archived.
```

## 2. Permit application (clarification loop + compliance review)
```
The applicant submits a building permit application via the portal.
The clerk verifies the application for completeness.
If information is missing, return to the applicant for clarification.
The reviewer assesses the application against regulations.
The department head approves the permit.
The system issues the permit and the process ends.
```

## 3. Role-prefixed SOP style
```
Sales: receive the customer order.
Warehouse: check stock availability.
Warehouse: if stock is missing, send back to receive the order.
Finance: verify the customer credit.
Manager: approve the shipment.
System: generate the shipping label.
```

## 4. Meeting-notes / conversational style
```
So basically the support agent picks up the ticket, then they triage it.
If it's urgent we escalate to the on-call engineer, otherwise it goes to the
normal queue. The engineer resolves it and we close the ticket.
```

# Sample follow-up instructions

Type these into **Update by instruction** (or use the quick-command chips):

- `Add an approval by the department head before shipment`
- `Create a rework loop for incomplete documents`
- `Add an exception path if the permit is missing`
- `Split procurement and site management into separate lanes`
- `Replace the triage with an XOR gateway`
- `Move the quality check before shipment`
- `Rename the check step to "Validate purchase order"`
- `Add a service task to notify the customer before the order is closed`
