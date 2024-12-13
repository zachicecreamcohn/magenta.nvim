import { createSignal } from './signal';
import {View as RenderView } from './view'


export type Update<Msg, Model> = (
  msg: Msg,
  model: Model,
) => [Model] | [Model, Thunk<Msg> | undefined];

export type Dispatch<Msg> = (msg: Msg) => void;

export type View<Msg, Model> = ({
  model,
  dispatch,
}: {
  model: Model;
  dispatch: Dispatch<Msg>;
}) => RenderView<{
  model: Accessor<Model>;
  dispatch: Dispatch<Msg>
}>;

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

export function createApp<Model, Msg, SubscriptionType extends string>({
  initialModel,
  update,
  View,
  sub,
}: {
  initialModel: Model;
  update: Update<Msg, Model>;
  View: View<Msg, Model>;
  sub?: {
    subscriptions: (model: Model) => Subscription<SubscriptionType>[];
    subscriptionManager: SubscriptionManager<SubscriptionType, Msg>;
  };
}) {
  let dispatchRef: { current: Dispatch<Msg> | undefined } = {
    current: undefined,
  };

  function App() {
    const [appState, setAppState] = createSignal({
      status: "running",
      model: initialModel,
    });

    const subs: {
      [id: string]: Subscription<SubscriptionType>;
    } = {};

    const dispatch = useCallback((msg: Msg) => {
      setAppState((currentState) => {
        if (currentState.status == "error") {
          return currentState;
        }

        try {
          const [nextModel, thunk] = update(msg, currentState.model);

          if (thunk) {
            // purposefully do not await
            thunk(dispatch);
          }

          return { status: "running", model: nextModel };
        } catch (e) {
          console.error(e);
          return { status: "error", error: (e as Error).message };
        }
      });
    }, []);

    dispatchRef.current = dispatch;

    React.useEffect(() => {
      if (!sub) return;
      if (appState.status != "running") return;

      const subscriptionManager = sub.subscriptionManager;
      const currentSubscriptions = subs.current;

      const nextSubs = sub.subscriptions(appState.model);
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
          delete subs.current[id];
        }
      });

      return () => {};
    }, [appState]);

    return (
      <div>
        {appState.status == "running" ? (
          <View model={appState.model} dispatch={dispatch} />
        ) : (
          <div>Error: {appState.error}</div>
        )}
      </div>
    );
  }

  return {
    mount(element: Element) {
      const root = createRoot(element);
      flushSync(() => root.render(<App />));
      return { root, dispatchRef };
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
