/**
 * Vitest jsdom setup.
 *
 * Antd's components rely on a few browser APIs jsdom doesn't ship:
 *   - ``window.matchMedia`` (used by Grid responsive breakpoints)
 *   - ``ResizeObserver`` (used by Card/Drawer/Modal portals)
 *   - ``IntersectionObserver`` (used by virtual lists)
 *
 * Recharts also wants ``ResizeObserver`` for the ``ResponsiveContainer``;
 * it'll log a console error otherwise even though our snapshot tests
 * don't actually render the chart at a real size.
 *
 * ``pdfjs-dist`` (pulled in by ``react-pdf``) builds a ``DOMMatrix`` at
 * module scope, so *any* import that transitively reaches
 * ``PdfDocumentPreview`` used to blow up during test collection with
 * ``ReferenceError: DOMMatrix is not defined`` — jsdom and Node 20 don't
 * provide that global. A minimal 2-D stub is enough: no unit test ever
 * renders a real PDF page.
 */

import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// --- ``DOMMatrix`` stub (needed by pdfjs-dist) ------------------------
// jsdom and Node don't expose the CSSOM ``DOMMatrix`` global, but
// ``pdfjs-dist`` instantiates one at module scope. Without a stub, merely
// importing a module that transitively reaches ``PdfDocumentPreview``
// fails during test *collection* with
// ``ReferenceError: DOMMatrix is not defined``.
//
// Only a 2-D matrix is implemented: no unit test renders a real PDF page,
// so the matrix is only ever constructed (never meaningfully used).
type _MatrixInit = {
  a?: number;
  b?: number;
  c?: number;
  d?: number;
  e?: number;
  f?: number;
};

class _DOMMatrix {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;

  constructor(init?: number[] | _MatrixInit | _DOMMatrix | null) {
    if (!init) return;
    if (Array.isArray(init)) {
      if (init.length >= 6) {
        [this.a, this.b, this.c, this.d, this.e, this.f] = init;
      }
      return;
    }
    if (init instanceof _DOMMatrix) {
      this.a = init.a;
      this.b = init.b;
      this.c = init.c;
      this.d = init.d;
      this.e = init.e;
      this.f = init.f;
      return;
    }
    this.a = init.a ?? 1;
    this.b = init.b ?? 0;
    this.c = init.c ?? 0;
    this.d = init.d ?? 1;
    this.e = init.e ?? 0;
    this.f = init.f ?? 0;
  }

  get isIdentity(): boolean {
    return (
      this.a === 1 &&
      this.b === 0 &&
      this.c === 0 &&
      this.d === 1 &&
      this.e === 0 &&
      this.f === 0
    );
  }

  get is2D(): boolean {
    return this.b === 0 && this.c === 0;
  }

  multiplySelf(other: _DOMMatrix): this {
    const a = this.a * other.a + this.c * other.b;
    const b = this.b * other.a + this.d * other.b;
    const c = this.a * other.c + this.c * other.d;
    const d = this.b * other.c + this.d * other.d;
    const e = this.a * other.e + this.c * other.f + this.e;
    const f = this.b * other.e + this.d * other.f + this.f;
    this.a = a;
    this.b = b;
    this.c = c;
    this.d = d;
    this.e = e;
    this.f = f;
    return this;
  }

  multiply(other: _DOMMatrix): _DOMMatrix {
    return new _DOMMatrix(this).multiplySelf(other);
  }

  preMultiplySelf(other: _DOMMatrix): this {
    const product = new _DOMMatrix(other).multiplySelf(this);
    this.a = product.a;
    this.b = product.b;
    this.c = product.c;
    this.d = product.d;
    this.e = product.e;
    this.f = product.f;
    return this;
  }

  preMultiply(other: _DOMMatrix): _DOMMatrix {
    return new _DOMMatrix(other).preMultiplySelf(this);
  }

  invertSelf(): this {
    const det = this.a * this.d - this.b * this.c;
    if (!det) return this;
    const a = this.d / det;
    const b = -this.b / det;
    const c = -this.c / det;
    const d = this.a / det;
    const e = (this.c * this.f - this.d * this.e) / det;
    const f = (this.b * this.e - this.a * this.f) / det;
    this.a = a;
    this.b = b;
    this.c = c;
    this.d = d;
    this.e = e;
    this.f = f;
    return this;
  }

  invert(): _DOMMatrix {
    return new _DOMMatrix(this).invertSelf();
  }

  translateSelf(tx: number, ty = 0): this {
    this.e += tx * this.a + ty * this.c;
    this.f += tx * this.b + ty * this.d;
    return this;
  }

  translate(tx: number, ty = 0): _DOMMatrix {
    return new _DOMMatrix(this).translateSelf(tx, ty);
  }

  scaleSelf(sx: number, sy: number = sx): this {
    this.a *= sx;
    this.b *= sx;
    this.c *= sy;
    this.d *= sy;
    return this;
  }

  scale(sx: number, sy: number = sx): _DOMMatrix {
    return new _DOMMatrix(this).scaleSelf(sx, sy);
  }
}

if (typeof globalThis.DOMMatrix === "undefined") {
  (globalThis as unknown as { DOMMatrix: unknown }).DOMMatrix = _DOMMatrix;
}

// jsdom ships no ``URL.createObjectURL`` / ``URL.revokeObjectURL``.
// Product asset previews download an authenticated blob and turn it into
// an object URL, and the cleanup path calls ``revokeObjectURL`` — which
// ``Array.prototype.forEach`` rejects even on an empty array when the
// callback is not callable. Stub both so the preview lifecycle runs.
if (typeof URL.createObjectURL !== "function") {
  let objectUrlSeq = 0;
  URL.createObjectURL = () => `blob:octop-test/${objectUrlSeq++}`;
}
if (typeof URL.revokeObjectURL !== "function") {
  URL.revokeObjectURL = () => {};
}

// Auto-mock react-i18next so components' ``t(key, fallback)`` calls
// resolve synchronously to ``fallback`` without needing the real
// i18n module (which would async-fetch tool labels and add 1-2s of
// console noise per test file).
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();

  type TOptions = Record<string, unknown> & { defaultValue?: string };

  // Interpolate ``{{name}}`` placeholders like real i18next so tests can
  // assert user-visible copy such as "已捕获 42 条对话记忆".
  const interpolate = (template: string, options?: TOptions): string => {
    if (!options) return template;
    return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
      name in options ? String(options[name]) : match,
    );
  };

  return {
    ...actual,
    useTranslation: () => ({
      t: (
        key: string,
        fallback?: string | TOptions,
        options?: TOptions,
      ): string => {
        if (typeof fallback === "string") return interpolate(fallback, options);
        if (fallback && typeof fallback === "object") {
          const template = fallback.defaultValue ?? key;
          return interpolate(template, fallback);
        }
        return key;
      },
      i18n: { language: "zh", changeLanguage: () => Promise.resolve() },
    }),
    Trans: ({ children }: { children?: React.ReactNode }) => children,
  };
});

afterEach(() => {
  cleanup();
});

if (typeof window !== "undefined") {
  // matchMedia
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  }

  // ResizeObserver
  class _ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  if (!window.ResizeObserver) {
    (
      window as unknown as { ResizeObserver: typeof _ResizeObserver }
    ).ResizeObserver = _ResizeObserver;
  }

  // IntersectionObserver
  class _IntersectionObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
    root = null;
    rootMargin = "";
    thresholds = [];
  }
  if (!window.IntersectionObserver) {
    (
      window as unknown as {
        IntersectionObserver: typeof _IntersectionObserver;
      }
    ).IntersectionObserver = _IntersectionObserver;
  }

  // jsdom doesn't implement ``getComputedStyle().transition`` properly,
  // so antd's wave / motion can throw — silence that one noisy console
  // warning without hiding real errors.
  const _origError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    const first = args[0];
    if (
      typeof first === "string" &&
      (first.includes(
        "Not implemented: HTMLFormElement.prototype.requestSubmit",
      ) ||
        first.includes("React does not recognize the") ||
        first.includes("antd: ") ||
        first.includes("[antd:"))
    ) {
      return;
    }
    _origError(...args);
  };
}
