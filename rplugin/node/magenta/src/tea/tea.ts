import { Context } from "../types.ts";
import { d, MountedView, MountPoint, mountView, VDOMNode } from "./view.ts";

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

export type App<Msg, Model> = {
  mount(mount: MountPoint): Promise<void>;
  unmount(): void;
  dispatch: Dispatch<Msg>;
  getState(): AppState<Model>;
};

export function createApp<Model, Msg, SubscriptionType extends string>({
  initialModel,
  update,
  View,
  sub,
  onUpdate,
  context,
}: {
  initialModel: Model;
  update: Update<Msg, Model>;
  View: View<Msg, Model>;
  onUpdate?: (msg: Msg, model: Model) => void;
  context: Context;
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

      if (thunk) {
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        thunk(dispatch, context);
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
    context.logger.trace(`starting render`);
    if (root) {
      renderPromise = root
        .render({ currentState, dispatch })
        .catch((err) => {
          context.logger.error(err as Error);
          throw err;
        })
        .finally(() => {
          if (reRender) {
            reRender = false;
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

export type Thunk<Msg> = (
  dispatch: Dispatch<Msg>,
  context: Context,
) => Promise<void>;

export function wrapThunk<MsgType extends string, InnerMsg>(
  msgType: MsgType,
  thunk: Thunk<InnerMsg> | undefined,
): Thunk<{ type: MsgType; msg: InnerMsg }> | undefined {
  if (!thunk) {
    return undefined;
  }
  return (
    dispatch: Dispatch<{ type: MsgType; msg: InnerMsg }>,
    context: Context,
  ) => thunk((msg: InnerMsg) => dispatch({ type: msgType, msg }), context);
}

export function chainThunks<Msg>(
  ...thunks: (Thunk<Msg> | undefined)[]
): Thunk<Msg> {
  return async (dispatch, context) => {
    for (const thunk of thunks) {
      if (thunk) {
        await thunk(dispatch, context);
      }
    }
  };
}
