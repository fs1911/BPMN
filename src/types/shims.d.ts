declare module "bpmn-js-properties-panel" {
  export const BpmnPropertiesPanelModule: any;
  export const BpmnPropertiesProviderModule: any;
}

// Vite asset URL imports (e.g. the pdf.js worker).
declare module "*?url" {
  const url: string;
  export default url;
}

declare module "bpmn-js-token-simulation/lib/modeler" {
  const module: any;
  export default module;
}
