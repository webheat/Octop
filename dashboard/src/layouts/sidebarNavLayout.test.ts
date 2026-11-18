import { describe, expect, it } from "vitest";
import type { OctopUser } from "../api/modules/auth";
import { buildNavSections } from "./sidebarNav";
import {
  createGroup,
  deleteGroup,
  editorFromCatalog,
  layoutFromEditor,
  placeItem,
  sectionsFromLayout,
  visibleEditorGroups,
} from "./sidebarNavLayout";

const adminUser = {
  id: 1,
  username: "admin",
  role: "admin",
  permissions: ["*"],
} as OctopUser;

const limitedUser = {
  id: 2,
  username: "ada",
  role: "user",
  permissions: [],
} as OctopUser;

function catalog() {
  return buildNavSections(adminUser, { mobileEnabled: true });
}

describe("sidebarNavLayout", () => {
  it("keeps the default catalog when no layout is saved", () => {
    const sections = catalog();
    expect(sectionsFromLayout(sections, null)).toBe(sections);
    const editor = editorFromCatalog(sections, null);
    // 专家 / 自动化 / Token 统计 已按产品要求从导航中移除
    expect(editor.ungrouped).toEqual(["chat", "product-library"]);
    expect(editor.groups.map((group) => group.id)).toEqual([
      "video",
      "settings",
      "control",
      "admin",
    ]);
    expect(editor.hidden).toEqual([]);
  });

  it("omits empty groups and hidden items from the sidebar", () => {
    const sections = catalog();
    const applied = sectionsFromLayout(sections, {
      groups: [
        { id: "settings", name: "配置" },
        { id: "control" },
        { id: "c_emptygrp1", name: "空组" },
      ],
      items: [
        { key: "chat" },
        { key: "personalization", group: "settings" },
        { key: "token-usage", hidden: true },
        { key: "workbench", group: "control" },
      ],
    });
    expect(applied.map((section) => section.id ?? "front")).toEqual([
      "front",
      "settings",
      "control",
      // 「视频制作向导」是本次新增的入口：存量布局里没有它，也没有 video
      // 分组，所以它落到新建的 video 分组并显示出来。
      "video",
    ]);
    expect(applied[0]?.items.map((item) => item.key)).toEqual(["chat"]);
    expect(applied[1]?.title).toBe("配置");
    expect(applied[1]?.items.map((item) => item.key)).toEqual([
      "personalization",
    ]);
    expect(applied[2]?.groupKey).toBe("nav.control");
    expect(applied[3]?.items.map((item) => item.key)).toEqual(["video-wizard"]);
  });

  it("sends keys missing from a saved layout to hidden", () => {
    const editor = editorFromCatalog(catalog(), {
      groups: [{ id: "settings" }],
      items: [{ key: "chat" }],
    });
    expect(editor.ungrouped).toEqual(["chat"]);
    expect(editor.hidden).toContain("product-library");
    expect(editor.hidden).toContain("personalization");
    expect(
      sectionsFromLayout(catalog(), {
        groups: [{ id: "settings" }],
        items: [{ key: "chat" }],
      })
        .flatMap((section) => section.items.map((item) => item.key))
        .includes("experts"),
    ).toBe(false);
  });

  it("moves a deleted group's items to the front of the ungrouped list", () => {
    const editor = editorFromCatalog(catalog(), null);
    const next = deleteGroup(editor, "settings");
    expect(next.groups.map((group) => group.id)).toEqual([
      "video",
      "control",
      "admin",
    ]);
    expect(next.ungrouped.slice(0, 2)).toEqual(["personalization", "channels"]);
    expect(next.ungrouped).toContain("chat");
  });

  it("places an item before another and can hide it", () => {
    const editor = editorFromCatalog(catalog(), null);
    const moved = placeItem(editor, "tasks", { kind: "ungrouped" }, "chat");
    expect(moved.ungrouped.slice(0, 2)).toEqual(["tasks", "chat"]);
    const hidden = placeItem(moved, "tasks", { kind: "hidden" }, null);
    expect(hidden.ungrouped).not.toContain("tasks");
    expect(hidden.hidden).toContain("tasks");
    const layout = layoutFromEditor(hidden);
    expect(layout.items.find((item) => item.key === "tasks")?.hidden).toBe(
      true,
    );
  });

  it("omits nav items and built-in groups the user cannot access", () => {
    const sections = buildNavSections(limitedUser, { mobileEnabled: false });
    const editor = editorFromCatalog(sections, {
      groups: [
        { id: "settings" },
        { id: "admin" },
        { id: "c_aabbccdd", name: "常用" },
      ],
      items: [
        { key: "chat" },
        { key: "admin-users", group: "admin" },
        { key: "channels", group: "settings" },
        { key: "personalization", group: "settings" },
      ],
    });
    const shown = [
      ...editor.ungrouped,
      ...Object.values(editor.itemsByGroup).flat(),
      ...editor.hidden,
    ];
    expect(shown).not.toContain("admin-users");
    expect(shown).not.toContain("channels");
    expect(shown).toContain("chat");
    expect(shown).not.toContain("personalization");
    // limitedUser 看不到任何设置项 → 内置 settings / admin 分组按设计被隐藏。
    // video 分组仍然保留：视频工具对所有账号可见，本次新增的「视频制作
    // 向导」就落在里面。
    expect(
      visibleEditorGroups(editor, sections).map((group) => group.id),
    ).toEqual(["c_aabbccdd", "video"]);
    // 能看到设置项的内置分组则保留。
    const adminSections = buildNavSections(adminUser, { mobileEnabled: true });
    const adminEditor = editorFromCatalog(adminSections, null);
    expect(
      visibleEditorGroups(adminEditor, adminSections).map((group) => group.id),
    ).toContain("settings");
  });

  it("keeps a new empty group only in the editor", () => {
    const editor = createGroup(
      editorFromCatalog(catalog(), null),
      "c_aabbccdd",
      "常用",
    );
    expect(editor.groups.at(-1)?.name).toBe("常用");
    const applied = sectionsFromLayout(catalog(), layoutFromEditor(editor));
    expect(applied.some((section) => section.id === "c_aabbccdd")).toBe(false);
  });
});

describe("newly added nav entries", () => {
  it("shows a newly added entry in a layout saved before it existed", () => {
    const sections = catalog();
    // A layout saved before the video tooling shipped: no "video" group and
    // no "video-wizard" entry.
    const legacy = {
      groups: [{ id: "settings" }, { id: "control" }],
      items: [{ key: "chat" }, { key: "video-environment", group: "control" }],
    };
    const editor = editorFromCatalog(sections, legacy);
    expect(editor.hidden).not.toContain("video-wizard");
    expect(editor.itemsByGroup.video).toEqual(["video-wizard"]);
    // The entry the user had placed keeps its placement.
    expect(editor.itemsByGroup.control).toEqual(["video-environment"]);

    const applied = sectionsFromLayout(sections, legacy);
    const video = applied.find((section) => section.id === "video");
    expect(video?.items.map((item) => item.key)).toEqual(["video-wizard"]);
  });

  it("keeps a newly added entry hidden when the user hid it explicitly", () => {
    const editor = editorFromCatalog(catalog(), {
      groups: [{ id: "video" }],
      items: [{ key: "video-wizard", hidden: true }],
    });
    expect(editor.hidden).toContain("video-wizard");
    expect(editor.itemsByGroup.video ?? []).not.toContain("video-wizard");
  });
});
