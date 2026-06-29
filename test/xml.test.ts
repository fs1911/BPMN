import { describe, expect, it } from "vitest";
import { exportBpmn, importBpmn } from "../src/core/xml";
import { autoLayout } from "../src/core/layout";
import { buildSampleProcess } from "./helpers";

describe("BPMN 2.0 XML import/export", () => {
  it("exports valid BPMN with DI and re-imports to an equivalent model", () => {
    const model = buildSampleProcess();
    autoLayout(model, "P");
    const xml = exportBpmn(model);

    expect(xml).toContain("<bpmn:definitions");
    expect(xml).toContain("<bpmn:process");
    expect(xml).toContain("<bpmn:exclusiveGateway");
    expect(xml).toContain("<bpmndi:BPMNDiagram");
    expect(xml).toContain("<di:waypoint");
    expect(xml).toContain("conditionExpression");

    const round = importBpmn(xml);
    expect(Object.keys(round.nodes).length).toBe(Object.keys(model.nodes).length);
    expect(Object.keys(round.edges).length).toBe(Object.keys(model.edges).length);
    // condition survives round trip
    const cond = Object.values(round.edges).find((e) => e.name === "incomplete");
    expect(cond?.condition).toBeTruthy();
    // geometry survives
    const start = round.nodes["start"];
    expect(start.bounds.width).toBeGreaterThan(0);
  });

  it("imports pools, lanes and message flows", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="Defs">
  <bpmn:collaboration id="C1">
    <bpmn:participant id="Pool_A" name="Customer" processRef="Proc_A" />
    <bpmn:participant id="Pool_B" name="Supplier" processRef="Proc_B" />
    <bpmn:messageFlow id="MF1" name="Order" sourceRef="T1" targetRef="T2" />
  </bpmn:collaboration>
  <bpmn:process id="Proc_A" isExecutable="true">
    <bpmn:laneSet id="LS1">
      <bpmn:lane id="Lane_1" name="Sales"><bpmn:flowNodeRef>T1</bpmn:flowNodeRef></bpmn:lane>
    </bpmn:laneSet>
    <bpmn:startEvent id="S1" name="Start" />
    <bpmn:userTask id="T1" name="Place order" />
    <bpmn:sequenceFlow id="F1" sourceRef="S1" targetRef="T1" />
  </bpmn:process>
  <bpmn:process id="Proc_B" isExecutable="true">
    <bpmn:serviceTask id="T2" name="Fulfil order" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="D1"><bpmndi:BPMNPlane id="PL1" bpmnElement="C1">
    <bpmndi:BPMNShape id="S1_di" bpmnElement="S1"><dc:Bounds x="10" y="10" width="36" height="36" /></bpmndi:BPMNShape>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;
    const m = importBpmn(xml);
    expect(Object.keys(m.participants).length).toBe(2);
    expect(Object.keys(m.lanes).length).toBe(1);
    expect(m.nodes["T1"].lane).toBe("Lane_1");
    const mf = Object.values(m.edges).find((e) => e.type === "messageFlow");
    expect(mf?.name).toBe("Order");
    expect(m.nodes["S1"].bounds).toEqual({ x: 10, y: 10, width: 36, height: 36 });
  });

  it("preserves event definitions and markers", () => {
    const xml = `<?xml version="1.0"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D">
  <bpmn:process id="P">
    <bpmn:startEvent id="s"><bpmn:messageEventDefinition /></bpmn:startEvent>
    <bpmn:userTask id="t"><bpmn:multiInstanceLoopCharacteristics isSequential="false" /></bpmn:userTask>
    <bpmn:endEvent id="e"><bpmn:terminateEventDefinition /></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;
    const m = importBpmn(xml);
    expect(m.nodes["s"].eventDefinition).toBe("message");
    expect(m.nodes["t"].markers?.multiInstance).toBe("parallel");
    expect(m.nodes["e"].eventDefinition).toBe("terminate");
  });
});
