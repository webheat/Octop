/// <reference types="vite/client" />
/// <reference types="vite-plugin-svgr/client" />

declare module "*.less" {
  const classes: { [key: string]: string };
  export default classes;
}

declare global {
  interface Window {
    /**
     * Set by the Octop desktop shell (Wails) on every navigation. The thin
     * build loads the Dashboard from the server, so this marker is the only
     * reliable way for the page to know it is not a browser — and therefore
     * must not register a Service Worker that would cache a stale frontend.
     */
    octopDesktopShell?: boolean;
    /**
     * The shell's video bridge. Every shell since v1.4.0 injects it, so it is
     * the signal that also identifies *older* shells.
     */
    octopDesktopVideo?: {
      version: number;
      minimalMode?: boolean;
      environmentVersion?: number;
      environmentInstallerURL?: string;
    };
    /**
     * The shell's runtime bridge. It installs optional runtime shards (the
     * Tencent Cloud SDK part, for example) when the server reports that a
     * feature misses its optional component.
     */
    octopDesktopRuntime?: {
      version: number;
      request(
        action: string,
        payload?: Record<string, unknown>,
      ): Promise<unknown>;
    };
    /**
     * The shell's local-first library bridge (PRD §3.7). Material bytes stay
     * on the client machine; the remote server is used only for AI recognition.
     * Absent in the browser, so feature detection gates every call.
     */
    octopDesktopLibrary?: {
      version: number;
      request(
        action: string,
        token: string,
        payload?: Record<string, unknown>,
      ): Promise<unknown>;
    };
  }
}

export {};
