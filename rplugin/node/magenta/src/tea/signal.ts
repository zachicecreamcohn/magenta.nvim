export type Accessor<T> = () => T;
export type Setter<T> = (value: T | ((prev: T) => T)) => void;
export type Signal<T> = [Accessor<T>, Signal<T>];

export function createSignal<T>(initialState: T) {
  let state: T = initialState;
  const subscribers: {
    [id: string]: Effect;
  } = {};

  function subscribe(effect: Effect) {
    subscribers[effect.id] = effect;
    effect.onDestroy.push(() => {
      delete subscribers[effect.id];
    });
  }

  const accessor: Accessor<T> = () => {
    const effect = EFFECT_STACK[EFFECT_STACK.length - 1];
    if (effect) {
      subscribe(effect);
    }
    return state;
  };

  const setter: Setter<T> = (value) => {
    if (typeof value == "function") {
      state = (value as (prev: T) => T)(state);
    } else {
      state = value;
    }

    for (const effect of Object.values(subscribers)) {
      effect.fn();
    }
  };

  return [accessor, setter];
}

const EFFECT_STACK: Effect[] = [];

export type Effect = {
  id: string;
  fn: () => void;
  onDestroy: (() => void)[];
  destroy: () => void;
};

let id = 0;
function nextId() {
  id += 1;
  return id.toString();
}

export function createEffect(fn: () => void) {
  const onDestroy: Effect["onDestroy"] = [];
  const effect: Effect = {
    id: nextId(),
    fn,
    onDestroy,
    destroy: () => {
      for (const destroy of onDestroy) {
        destroy();
      }
    },
  };

  EFFECT_STACK.push(effect);
  try {
    // on initial execution, see which subscribers are used.
    fn();
  } finally {
    EFFECT_STACK.pop();
  }
}
