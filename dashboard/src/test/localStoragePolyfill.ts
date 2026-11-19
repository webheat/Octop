/**
 * In-memory `localStorage` for jsdom.
 *
 * Node's own `--localstorage-file` warning aside, the jsdom global accessor can
 * be defined yet return `undefined`, which makes every suite that touches
 * storage die on `localStorage.clear()`. Tests only need the Web Storage
 * contract, so a plain `Map` keeps them deterministic and environment-agnostic.
 */
/**
 * Keep the platform's own `Storage` constructor in the prototype chain, so a
 * suite that stubs `Storage.prototype.setItem` (quota failures) also affects
 * this instance. Falling back to `Object` keeps the stub-less path working.
 */
const StorageBase: { prototype: object } =
  typeof Storage === "function" ? Storage : Object;

class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();

  get length(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }

  getItem(key: string): string | null {
    return this.items.get(String(key)) ?? null;
  }

  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.items.delete(String(key));
  }

  setItem(key: string, value: string): void {
    this.items.set(String(key), String(value));
  }
}

/** Replace `window.localStorage` when the environment does not provide one. */
export function installMemoryLocalStorage(): void {
  if (typeof window === "undefined") return;
  if (window.localStorage) return;
  const memory = new MemoryStorage();
  // jsdom's `Storage` binds `this` to internal slots, so a bare object fails
  // its brand check. Proxy every call to the in-memory implementation while
  // keeping the platform prototype, which makes both `instanceof Storage` and
  // `Storage.prototype.setItem` spies behave like a real store.
  const storage =
    StorageBase === Object
      ? memory
      : new Proxy(memory, {
          getPrototypeOf: () => StorageBase.prototype,
          get: (target, prop) => {
            const value = Reflect.get(target, prop, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
  Object.defineProperty(window, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
}
