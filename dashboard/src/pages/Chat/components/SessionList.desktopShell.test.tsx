import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, vi } from "vitest";

vi.mock("../../Experts/components/EditAgentDrawer", () => ({
  default: () => null,
}));
vi.mock("../../Experts/components/TeamDrawer", () => ({
  default: ({ open }: { open: boolean }) =>
    open ? <div role="dialog" aria-label="team-drawer" /> : null,
}));
vi.mock("../../Experts/components/CreateFromExpertDrawer", () => ({
  default: () => null,
}));
vi.mock("../../Settings/AdvancedSettings/BridgeSettings", () => ({
  default: ({ createOnly }: { createOnly?: boolean }) =>
    createOnly ? <div role="dialog" aria-label="cloud-drawer" /> : null,
}));

import type { OctopAgent } from "../../../context/AgentContext";
import { octopThreadsApi } from "../../../api/modules/octopThreads";
import SessionList from "./SessionList";

function agent(
  partial: Pick<OctopAgent, "agent_id" | "name"> &
    Partial<Pick<OctopAgent, "kind" | "bridge">>,
): OctopAgent {
  return {
    description: null,
    persona_mbti: null,
    default_model: null,
    system_prompt: null,
    template_name: null,
    state: "running",
    last_error: null,
    icon: null,
    icon_name: null,
    icon_url: null,
    color: null,
    config: {},
    ...partial,
  };
}

const localExpert = agent({ agent_id: "local-expert", name: "本地专家" });
const localTeam = agent({
  agent_id: "local-team",
  name: "本地团队",
  kind: "team",
});
const cloudExpert = agent({
  agent_id: "bridge:c1:expert",
  name: "云端专家",
  bridge: true,
});

function renderList(agents: OctopAgent[], activeAgentId = "local-expert") {
  render(
    <MemoryRouter>
      <SessionList
        agents={agents}
        sessions={[]}
        activeId={null}
        activeAgentId={activeAgentId}
        hasMore={false}
        loadingMore={false}
        onLoadMore={() => undefined}
        onFetchAllSessions={() => undefined}
        onSelect={() => undefined}
        onAgentSelect={() => undefined}
        onNewChat={() => undefined}
        onDelete={() => undefined}
        onRename={() => undefined}
        onPin={() => undefined}
        onFork={() => undefined}
      />
    </MemoryRouter>,
  );
}

describe("SessionList in the desktop shell", () => {
  beforeEach(() => {
    vi.spyOn(octopThreadsApi, "list").mockResolvedValue([]);
    localStorage.clear();
    // The shell marks the profile, so every navigation knows it is desktop.
    localStorage.setItem("octop.desktopShell", "1");
  });

  it("hides the scope tabs and the create entries", () => {
    renderList([localExpert]);

    expect(screen.queryByRole("tab", { name: "专家" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "团队" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "云端" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "创建专家" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("本地专家")).toBeInTheDocument();
  });

  it("lists every assistant of the account instead of one nav group", () => {
    // The scope starts on "experts" (the active chat is an expert); without
    // the grouping every kind of assistant must still be listed.
    renderList([localExpert, localTeam, cloudExpert]);

    expect(screen.getByText("本地专家")).toBeInTheDocument();
    expect(screen.getByText("本地团队")).toBeInTheDocument();
    expect(screen.getByText("云端专家")).toBeInTheDocument();
  });

  it("keeps the empty rail free of the create-expert nudge", () => {
    renderList([], null);

    expect(
      screen.queryByRole("button", { name: "创建专家" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "创建第一个团队" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("chat.noAgentsTitle")).toBeInTheDocument();
  });
});

describe("SessionList in the browser", () => {
  beforeEach(() => {
    vi.spyOn(octopThreadsApi, "list").mockResolvedValue([]);
    localStorage.clear();
  });

  it("keeps the full console", () => {
    renderList([localExpert]);

    expect(screen.getByRole("tab", { name: "专家" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "创建专家" }),
    ).toBeInTheDocument();
    // Teams stay behind their own tab, exactly as before.
    expect(screen.queryByText("本地团队")).not.toBeInTheDocument();
  });
});
