/** Views should implement this interface to be compatible with Bind. */
export interface View<State, _Message = never> {
  container: HTMLElement;
  sync(state: State): void;
  destroy(): void;
}

/** Constructor signature for Views. */
type ViewCtor<State, Message = never> = new (
  container: HTMLElement,
  dispatch: (msg: Message) => void,
  initialState: State,
) => View<State, Message>;

/** Opaque descriptor returned by show(). Pass to bindSlot; do not inspect. */
export type SlotContent = {
  readonly __brand: "SlotContent";
};

/** Opaque descriptor returned by showKeyed(). Pass to bindList; do not inspect. */
export type KeyedSlotContent = {
  readonly __brand: "KeyedSlotContent";
};

interface SlotContentInternal {
  ctor: ViewCtor<unknown, unknown>;
  state: unknown;
  childDispatch: (childMsg: unknown) => void;
}

interface KeyedSlotContentInternal {
  key: string;
  ctor: ViewCtor<unknown, unknown>;
  state: unknown;
  childDispatch: (childMsg: unknown) => void;
}

export const noop = () => {};

/**
 * Describes which view to show with which state, without actually mounting anything.
 * The slot reads this descriptor and handles the lifecycle: mount if new, sync if
 * the same view is already shown, or destroy-and-remount if the constructor changed.
 * childDispatch is the dispatch function passed to the child view. Use noop for leaf views.
 */
export function show<ChildState, ChildMsg>(
  ViewClass: ViewCtor<ChildState, ChildMsg>,
  state: ChildState,
  childDispatch: (childMsg: ChildMsg) => void,
): SlotContent {
  return {
    ctor: ViewClass,
    state,
    childDispatch,
  } as unknown as SlotContent;
}

/**
 * Like show, but uses a key to distinguish identity instead of the ViewClass.
 */
export function showKeyed<ChildState, ChildMsg>(
  key: string,
  ViewClass: ViewCtor<ChildState, ChildMsg>,
  state: ChildState,
  childDispatch: (childMsg: ChildMsg) => void,
): KeyedSlotContent {
  return {
    key,
    ctor: ViewClass,
    state,
    childDispatch,
  } as unknown as KeyedSlotContent;
}

type Binding<State> = (state: State) => void;

/**
 * Manages bindings between state and DOM. Created in a view's constructor after setting innerHTML.
 * On each sync(), all registered bindings re-run with the new state.
 * On cleanup(), all child views are destroyed and bindings are cleared.
 */
export class Binder<State> {
  private bindings: Binding<State>[] = [];
  private cleanups: (() => void)[] = [];

  private state: State;

  constructor(
    private container: HTMLElement,
    initialState: State,
  ) {
    this.state = initialState;
  }

  /** Query a single element by its data-ref attribute. Throws if not exactly one match. */
  ref<T extends HTMLElement = HTMLElement>(name: Ref): T {
    const els = this.container.querySelectorAll<T>(`[data-ref="${name}"]`);
    if (els.length !== 1) {
      throw new Error(`ref("${name}"): expected 1 match, found ${els.length}`);
    }
    return els[0];
  }

  sync(state: State): void {
    this.state = state;
    for (const b of this.bindings) b(state);
  }

  cleanup(): void {
    for (const c of this.cleanups) c();
    this.cleanups = [];
    this.bindings = [];
  }

  /** Bind the text of the element via textContent (for XSS protection) */
  bindText(ref: Ref, fn: (s: State) => string): void {
    const el = this.ref(ref);
    const binding = (s: State) => {
      el.textContent = fn(s);
    };
    this.bindings.push(binding);
    binding(this.state);
  }

  bindClass(ref: Ref, fn: (s: State) => string): void {
    const el = this.ref(ref);
    const binding = (s: State) => {
      el.className = fn(s);
    };
    this.bindings.push(binding);
    binding(this.state);
  }

  /** show or hide the element via display=none */
  bindVisible(ref: Ref, fn: (s: State) => boolean): void {
    const el = this.ref(ref);
    const binding = (s: State) => {
      el.style.display = fn(s) ? "" : "none";
    };
    this.bindings.push(binding);
    binding(this.state);
  }

  /** Set inline styles on the element via a record. Clears properties removed between syncs. Values containing url( are stripped for safety. */
  bindStyle(ref: Ref, fn: (s: State) => Record<string, string>): void {
    const el = this.ref(ref);
    let prevKeys = new Set<string>();
    const binding = (s: State) => {
      const styles = fn(s);
      const nextKeys = new Set<string>();
      for (const [prop, val] of Object.entries(styles)) {
        el.style.setProperty(prop, val.replace(/url\s*\(/gi, ""));
        nextKeys.add(prop);
      }
      for (const prop of prevKeys) {
        if (!nextKeys.has(prop)) el.style.removeProperty(prop);
      }
      prevKeys = nextKeys;
    };
    this.bindings.push(binding);
    binding(this.state);
  }

  bindDisabled(ref: Ref, fn: (s: State) => boolean): void {
    const el = this.ref<HTMLButtonElement | HTMLInputElement>(ref);
    const binding = (s: State) => {
      el.disabled = fn(s);
    };
    this.bindings.push(binding);
    binding(this.state);
  }

  bindAttr(ref: Ref, attr: string, fn: (s: State) => string | undefined): void {
    const el = this.ref(ref);
    const binding = (s: State) => {
      const val = fn(s);
      if (val === undefined) el.removeAttribute(attr);
      else el.setAttribute(attr, val);
    };
    this.bindings.push(binding);
    binding(this.state);
  }

  /** Conditionally mount/unmount a child view. Return show() to mount, undefined to unmount. */
  bindSlot(ref: Ref, fn: (s: State) => SlotContent | undefined): void {
    const el = this.ref(ref);
    let currentCtor: SlotContentInternal["ctor"] | undefined;
    let currentView: View<unknown, unknown> | undefined;

    const cleanup = () => {
      if (currentView) {
        currentView.destroy();
        el.innerHTML = "";
        currentView = undefined;
        currentCtor = undefined;
      }
    };

    const binding = (s: State) => {
      const result = fn(s);
      const content = result as unknown as SlotContentInternal | undefined;
      if (!content) {
        cleanup();
      } else if (content.ctor !== currentCtor) {
        cleanup();
        currentView = new content.ctor(
          el,
          content.childDispatch,
          content.state,
        );
        currentCtor = content.ctor;
      } else {
        currentView?.sync(content.state as State);
      }
    };
    this.bindings.push(binding);
    binding(this.state);

    this.cleanups.push(cleanup);
  }

  /** Keyed list reconciliation. Maps an array of showKeyed() descriptors to child views. */
  bindList(
    ref: Ref,
    childTag: string,
    fn: (s: State) => KeyedSlotContent[],
  ): void {
    const el = this.ref(ref);
    const children = new Map<
      string,
      {
        view: View<unknown>;
        ctor: ViewCtor<unknown, unknown>;
        el: HTMLElement;
      }
    >();

    const cleanup = () => {
      for (const [, child] of children) child.view.destroy();
      children.clear();
      el.innerHTML = "";
    };

    const binding = (s: State) => {
      const items = fn(s) as unknown as KeyedSlotContentInternal[];
      const nextKeys = new Set<string>();

      for (const item of items) {
        nextKeys.add(item.key);
        let child = children.get(item.key);

        if (child && child.ctor !== item.ctor) {
          child.view.destroy();
          child.el.innerHTML = "";
          const newView = new item.ctor(
            child.el,
            item.childDispatch,
            item.state,
          );
          child.view = newView;
          child.ctor = item.ctor;
        } else if (!child) {
          const childEl = document.createElement(childTag);
          const view = new item.ctor(childEl, item.childDispatch, item.state);
          child = { view, ctor: item.ctor, el: childEl };
          children.set(item.key, child);
        }

        child.view.sync(item.state);
      }

      for (const [key, child] of children) {
        if (!nextKeys.has(key)) {
          child.el.remove();
          child.view.destroy();
          children.delete(key);
        }
      }

      // appendChild of an existing child moves it — this reorders in one pass
      for (const item of items) {
        const child = children.get(item.key);
        if (child) el.appendChild(child.el);
      }
    };
    this.bindings.push(binding);
    binding(this.state);

    this.cleanups.push(cleanup);
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Tagged template that HTML-escapes all interpolated values. Use for all innerHTML assignments. */
export function sanitize(
  strings: TemplateStringsArray,
  ...values: unknown[]
): string {
  return strings.reduce(
    (out, str, i) =>
      out + str + (i < values.length ? escapeHtml(String(values[i])) : ""),
    "",
  );
}

/** Branded string type for data-ref names. Prevents accidental use of raw strings in binder methods. */
export type Ref = string & { readonly __brand: "Ref" };

let refCounter = 0;

/** Generate a unique data-ref name. Use in templates and binder methods to avoid cross-view collisions. */
export function ref(prefix: string): Ref {
  return `${prefix}_${refCounter++}` as Ref;
}

let clsCounter = 0;

/** Generate a unique CSS class name. Avoids style collisions between components. */
export function cls(prefix: string): string {
  return `${prefix}_${clsCounter++}`;
}

/** Inject a raw CSS string into the page via a <style> tag. */
export function mountStyle(css: string): void {
  const el = document.createElement("style");
  el.textContent = css;
  document.head.appendChild(el);
}
