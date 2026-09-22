declare module "@opencode/plugin/tui" {
  export interface Context {
    readonly location?: { readonly directory: string };
    readonly ui: {
      readonly router: {
        current():
          | { readonly type: "home" }
          | { readonly type: "session"; readonly sessionID: string }
          | { readonly type: "plugin"; readonly id: string; readonly name: string };
      };
    };
    readonly data: {
      readonly on: (
        type: string,
        handler: (event: { readonly type: string; readonly data: Record<string, unknown> }) => void,
      ) => () => void;
      readonly session: {
        get(sessionID: string):
          | {
              readonly id: string;
              readonly title?: string;
              readonly location: { readonly directory: string };
              readonly time?: { readonly updated?: number };
            }
          | undefined;
        root(sessionID: string): string;
        family(sessionID: string): string[];
        status(sessionID: string): "idle" | "running";
        sync(sessionID: string): Promise<void>;
        invalidate(sessionID: string): void;
        readonly pending: {
          list(sessionID: string): unknown[];
          sync(sessionID: string): Promise<void>;
          invalidate(sessionID: string): void;
        };
        readonly permission: {
          list(sessionID: string): unknown[] | undefined;
          sync(sessionID: string): Promise<void>;
          invalidate(sessionID: string): void;
        };
        readonly form: {
          list(sessionID: string):
            | Array<{
                readonly id: string;
                readonly fields: ReadonlyArray<{
                  readonly type: string;
                  readonly options?: readonly unknown[];
                }>;
              }>
            | undefined;
          sync(sessionID: string): Promise<void>;
          invalidate(sessionID: string): void;
        };
      };
    };
  }

  export namespace Plugin {
    type Cleanup = () => Promise<void> | void;
    interface Definition {
      readonly id: string;
      readonly setup: (context: Context) => Promise<Cleanup | void> | Cleanup | void;
    }
    function define(plugin: Definition): Definition;
  }
}
