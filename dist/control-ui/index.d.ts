// Types for the dependency-free browser module (shape of OpenClaw's ControlUiPlugin).
declare const plugin: {
  id: string;
  activate(host: unknown): void | (() => void) | Promise<void | (() => void)>;
};
export default plugin;
