import {
  ByteIdx,
  d,
  MountedVDOM,
  MountedView,
  MountPoint,
  mountView,
  prettyPrintMountedNode,
  VDOMNode,
} from "./view.ts";
import { context } from "../context.ts";
import { BINDING_KEYS, BindingKey, getBindings } from "./bindings.ts";

export type Dispatch<Msg> = (msg: Msg) => void;

export type Update<Msg, Model> = (
  msg: Msg,
  model: Model,
) => [Model] | [Model, Thunk<Msg> | undefined];

export type View<Msg, Model> = ({
  model,
  dispatch,
}: {
  model: Model;
  dispatch: Dispatch<Msg>;
}) => VDOMNode;

export interface Subscription<SubscriptionType extends string> {
  /** Must be unique!
   */
  id: SubscriptionType;
}

export type SubscriptionManager<SubscriptionType extends string, Msg> = {
  [K in SubscriptionType]: {
    subscribe(dispatch: Dispatch<Msg>): void;
    unsubscribe(): void;
  };
};

type AppState<Model> =
  | {
      status: "running";
      model: Model;
    }
  | {
      status: "error";
      error: string;
    };

export type MountedApp = {
  onKey(key: BindingKey): void;
  getMountedNode(): MountedVDOM;
  waitForRender(): Promise<void>;
};

export type App<Msg, Model> = {
  mount(mount: MountPoint): Promise<MountedApp>;
  unmount(): void;
  dispatch: Dispatch<Msg>;
  getState(): AppState<Model>;
};

export function createApp<Model, Msg, SubscriptionType extends string>({
  initialModel,
  update,
  View,
  sub,
  suppressThunks,
  onUpdate,
}: {
  initialModel: Model;
  update: Update<Msg, Model>;
  View: View<Msg, Model>;
  onUpdate?: (msg: Msg, model: Model) => void;
  /** During testing, we probably don't want thunks to run
   */
  suppressThunks?: boolean;
  sub?: {
    subscriptions: (model: Model) => Subscription<SubscriptionType>[];
    subscriptionManager: SubscriptionManager<SubscriptionType, Msg>;
  };
}): App<Msg, Model> {
  let currentState: AppState<Model> = {
    status: "running",
    model: initialModel,
  };
  let root:
    | MountedView<{ currentState: AppState<Model>; dispatch: Dispatch<Msg> }>
    | undefined;

  let renderPromise: Promise<void> | undefined;
  let reRender = false;

  const dispatch = (msg: Msg) => {
    context.logger.trace(`dispatched msg ${JSON.stringify(msg)}`);
    if (currentState.status == "error") {
      return currentState;
    }

    try {
      const [nextModel, thunk] = update(msg, currentState.model);

      if (thunk && !suppressThunks) {
        context.logger.trace(`starting thunk`);
        thunk(dispatch).catch((err) => {
          context.logger.error(err as Error);
        });
      }

      currentState = { status: "running", model: nextModel };
      updateSubs(currentState);

      if (renderPromise) {
        reRender = true;
      } else {
        render();
      }

      if (onUpdate) {
        onUpdate(msg, currentState.model);
      }
    } catch (e) {
      context.logger.error(e as Error);
      currentState = { status: "error", error: (e as Error).message };
    }
  };

  function render() {
    if (root) {
      renderPromise = root
        .render({ currentState, dispatch })
        .catch((err) => {
          context.logger.error(err as Error);
          throw err;
        })
        .finally(() => {
          renderPromise = undefined;
          if (reRender) {
            reRender = false;
            context.logger.trace(`scheduling followup render`);
            render();
          }
        });
    }
  }

  const subs: {
    [id: string]: Subscription<SubscriptionType>;
  } = {};

  function updateSubs(currentState: AppState<Model>) {
    if (!sub) return;
    if (currentState.status != "running") return;

    const subscriptionManager = sub.subscriptionManager;
    const currentSubscriptions = subs;

    const nextSubs = sub.subscriptions(currentState.model);
    const nextSubsMap: { [id: string]: Subscription<SubscriptionType> } = {};

    // Add new subs
    nextSubs.forEach((sub) => {
      nextSubsMap[sub.id] = sub;
      if (!subscriptionManager[sub.id]) {
        subscriptionManager[sub.id].subscribe(dispatch);
        currentSubscriptions[sub.id] = sub;
      }
    });

    // Remove old subs
    Object.keys(currentSubscriptions).forEach((id) => {
      if (!nextSubsMap[id]) {
        subscriptionManager[id as SubscriptionType].unsubscribe();
        delete subs[id];
      }
    });

    return () => {};
  }

  updateSubs(currentState);

  function App({
    currentState,
    dispatch,
  }: {
    currentState: AppState<Model>;
    dispatch: Dispatch<Msg>;
  }) {
    return d`${
      currentState.status == "running"
        ? View({ model: currentState.model, dispatch })
        : d`Error: ${currentState.error}`
    }`;
  }

  return {
    async mount(mount: MountPoint) {
      root = await mountView({
        view: App,
        mount,
        props: { currentState, dispatch },
      });

      for (const key in BINDING_KEYS) {
        const vimKey = BINDING_KEYS[key as BindingKey];
        await context.nvim.call("nvim_buf_set_keymap", [
          mount.buffer.id,
          "n",
          vimKey,
          ":MagentaKey Enter<CR>",
          { noremap: true, silent: true },
        ]);
      }

      return {
        getMountedNode() {
          return root!._getMountedNode();
        },

        async waitForRender() {
          if (renderPromise) {
            await renderPromise;
          }
        },

        async onKey(key: BindingKey) {
          const window = await context.nvim.window;
          const [row, col] = (await window.cursor) as [ByteIdx, ByteIdx];
          if (root) {
            context.logger.trace(
              `Trying to find bindings for node ${prettyPrintMountedNode(root._getMountedNode())}`,
            );

            // win_get_cursor is 1-indexed, while our positions are 0-indexed
            const bindings = getBindings(root._getMountedNode(), {
              row: (row - 1) as ByteIdx,
              col,
            });
            if (bindings && bindings[key]) {
              bindings[key]();
            }
          } else {
            context.logger.debug(
              `Got onKey event ${key}, but root is no longer mounted.`,
            );
          }
        },
      };
    },
    unmount() {
      if (root) {
        root.unmount();
        root = undefined;
      }
    },
    dispatch,
    getState() {
      return currentState;
    },
  };
}

export type Thunk<Msg> = (dispatch: Dispatch<Msg>) => Promise<void>;

export function wrapThunk<MsgType extends string, InnerMsg>(
  msgType: MsgType,
  thunk: Thunk<InnerMsg> | undefined,
): Thunk<{ type: MsgType; msg: InnerMsg }> | undefined {
  if (!thunk) {
    return undefined;
  }
  return (dispatch: Dispatch<{ type: MsgType; msg: InnerMsg }>) =>
    thunk((msg: InnerMsg) => dispatch({ type: msgType, msg }));
}

export function chainThunks<Msg>(
  ...thunks: (Thunk<Msg> | undefined)[]
): Thunk<Msg> {
  return async (dispatch) => {
    for (const thunk of thunks) {
      if (thunk) {
        await thunk(dispatch);
      }
    }
  };
}

export function parallelThunks<Msg>(
  ...thunks: (Thunk<Msg> | undefined)[]
): Thunk<Msg> {
  return async (dispatch) => {
    await Promise.all(thunks.map((t) => t && t(dispatch)));
  };
}
