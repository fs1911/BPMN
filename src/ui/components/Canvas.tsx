import { useEffect, useRef } from "react";
import Modeler from "bpmn-js/lib/Modeler";
import {
  BpmnPropertiesPanelModule,
  BpmnPropertiesProviderModule,
} from "bpmn-js-properties-panel";
import { markPristine, useEditor } from "@state/store";
import { translateModule } from "@ui/bpmn/translate-de";
import { fitViewport, initialXml } from "@ui/bpmn/bridge";
import { plainTasksModule, setShowTaskTypes } from "@ui/bpmn/plain-tasks";

/**
 * The editing surface is bpmn-js (the bpmn.io toolkit): professional rendering,
 * palette, context pad, direct label editing and a properties panel. The custom
 * FlowCraft engine plugs in via the store actions (AI, cleanup, validation).
 */
export function Canvas() {
  const canvasRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const setModeler = useEditor((s) => s.setModeler);
  const setReady = useEditor((s) => s.setReady);

  useEffect(() => {
    if (!canvasRef.current || !panelRef.current) return;
    const modeler = new Modeler({
      container: canvasRef.current,
      propertiesPanel: { parent: panelRef.current },
      additionalModules: [
        BpmnPropertiesPanelModule,
        BpmnPropertiesProviderModule,
        translateModule(),
        plainTasksModule,
      ],
      keyboard: { bindTo: document },
    });
    setShowTaskTypes(modeler, useEditor.getState().showTaskTypes);
    setModeler(modeler);

    let disposed = false;
    modeler
      .importXML(initialXml())
      .then(async () => {
        if (disposed) return;
        fitViewport(modeler);
        setReady(true);
        await markPristine();
        // Continue where the user left off.
        await useEditor.getState().restoreLast();
        void useEditor.getState().revalidate();
      })
      .catch((err: unknown) => console.error("Initial import failed", err));

    const onChange = () => {
      void useEditor.getState().revalidate();
      useEditor.getState().noteChange();
    };
    modeler.on("commandStack.changed", onChange);
    modeler.on("import.done", onChange);

    return () => {
      disposed = true;
      modeler.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="editor">
      <div ref={canvasRef} className="bjs-canvas" />
      <div ref={panelRef} className="bjs-properties" />
    </div>
  );
}
