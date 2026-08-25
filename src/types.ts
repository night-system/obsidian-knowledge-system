/**
 * Ambient type declarations for the Obsidian runtime globals that this plugin
 * relies on but that are not part of the official `obsidian` type definitions.
 */

// Obsidian exposes the `moment` library on the global `window` object (many
// community plugins — e.g. Templater — depend on it). We use it for parsing and
// formatting user-configured timestamps without adding a runtime dependency.
declare global {
  interface Window {
    moment: any;
  }
}

export {};
