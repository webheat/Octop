import { describe, expect, it } from "vitest";
import {
  SIDEBAR_GROUPED_NAV_KEYS,
  SIDEBAR_NAV_KEYS,
  TEMP_HIDDEN_NAV_KEYS,
  buildNavSections,
  hideTempNavItems,
  isGroupedNavKey,
} from "./sidebarNav";
import type { OctopUser } from "../api/modules/auth";

const adminUser = {
  id: 1,
  username: "admin",
  role: "admin",
  permissions: ["*"],
} as OctopUser;

describe("sidebarNav", () => {
  it("marks catalog keys as grouped", () => {
    for (const key of SIDEBAR_GROUPED_NAV_KEYS) {
      expect(isGroupedNavKey(key)).toBe(true);
    }
    expect(isGroupedNavKey("chat")).toBe(false);
    expect(isGroupedNavKey("experts")).toBe(false);
  });

  it("places grouped keys only under sections with groupKey", () => {
    const sections = buildNavSections(adminUser, { mobileEnabled: true });
    const flatKeys = new Set(
      sections
        .filter((s) => !s.groupKey)
        .flatMap((s) => s.items.map((i) => i.key)),
    );
    const groupedKeys = new Set(
      sections
        .filter((s) => s.groupKey)
        .flatMap((s) => s.items.map((i) => i.key)),
    );
    for (const key of groupedKeys) {
      expect(isGroupedNavKey(key)).toBe(true);
      expect(flatKeys.has(key)).toBe(false);
    }
    for (const key of flatKeys) {
      expect(isGroupedNavKey(key)).toBe(false);
    }
  });

  it("covers every catalog key from the admin nav", () => {
    const keys = buildNavSections(adminUser, { mobileEnabled: true }).flatMap(
      (section) => section.items.map((item) => item.key),
    );
    // 专家 / 自动化 / Token 统计 已按产品要求从导航中移除，但仍保留在
    // SIDEBAR_NAV_KEYS 目录里以兼容已保存的旧用户布局（见 sidebarNav.tsx）。
    const notRendered = ["experts", "tasks", "token-usage"];
    expect(new Set(keys)).toEqual(
      new Set(SIDEBAR_NAV_KEYS.filter((key) => !notRendered.includes(key))),
    );
    const grouped = buildNavSections(adminUser, { mobileEnabled: true }).filter(
      (section) => section.id,
    );
    expect(grouped.map((section) => section.id)).toEqual([
      "video",
      "settings",
      "control",
      "admin",
    ]);
  });

  it("temporarily hides the settings entries without changing the catalog", () => {
    const sections = hideTempNavItems(
      buildNavSections(adminUser, { mobileEnabled: true }),
    );
    const keys = sections.flatMap((section) =>
      section.items.map((item) => item.key),
    );
    for (const key of TEMP_HIDDEN_NAV_KEYS) {
      expect(keys).not.toContain(key);
    }
    expect(sections.some((section) => section.id === "settings")).toBe(false);
    expect(keys).toContain("chat");
    expect(keys).toContain("product-library");
  });

  it("exposes separate local library and video entries in the desktop shell", () => {
    const keys = buildNavSections(adminUser, {
      mobileEnabled: true,
      isDesktop: true,
    })
      .flatMap((section) => section.items)
      .map((item) => item.key);
    expect(keys).toContain("local-library");
    expect(keys).not.toContain("product-library");
    expect(keys).toContain("video-wizard");
    const items = buildNavSections(adminUser, { isDesktop: true }).flatMap(
      (section) => section.items,
    );
    expect(items.find((item) => item.key === "local-library")?.path).toBe(
      "/local-library",
    );
    expect(items.find((item) => item.key === "video-wizard")?.path).toBe(
      "/local-video-wizard",
    );
  });
});
