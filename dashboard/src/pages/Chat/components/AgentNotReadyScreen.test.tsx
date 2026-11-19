import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { OctopAgent } from "../../../context/AgentContext";
import AgentNotReadyScreen from "./AgentNotReadyScreen";

function agentWith(overrides: Partial<OctopAgent>): OctopAgent {
  return {
    id: 1,
    agent_id: "a1",
    name: "小助手",
    description: null,
    persona_mbti: null,
    default_model: null,
    system_prompt: null,
    template_name: null,
    state: "failed",
    last_error: null,
    icon: null,
    icon_name: null,
    icon_url: null,
    color: null,
    ...overrides,
  };
}

function renderScreen(agent: OctopAgent, canConfigureModels?: boolean) {
  return render(
    <MemoryRouter initialEntries={["/chat"]}>
      <AgentNotReadyScreen
        agent={agent}
        canConfigureModels={canConfigureModels}
      />
    </MemoryRouter>,
  );
}

/**
 * "No model configured" arrives as a failed agent start, so this screen used to
 * announce "专家启动失败" behind a red cross for what is really an unfinished
 * setup step. The friendly prompt already exists for that case; these pin the
 * routing between the two.
 */
describe("AgentNotReadyScreen", () => {
  it("answers a missing model with the setup prompt, not a failure", () => {
    renderScreen(
      agentWith({ last_error: "octop:agent_errors.no_models_configured" }),
    );

    expect(screen.getByText("modelConfig.promptTitle")).toBeInTheDocument();
    expect(screen.queryByText("chat.agentFailed")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "modelConfig.configureButton" }),
    ).toBeInTheDocument();
  });

  it("offers no settings button to someone who cannot configure models", () => {
    renderScreen(
      agentWith({ last_error: "octop:agent_errors.no_models_configured" }),
      false,
    );

    expect(screen.getByText("modelConfig.promptTitle")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "modelConfig.configureButton" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the failure state for errors that are not about models", () => {
    renderScreen(agentWith({ last_error: "harness crashed on boot" }));

    expect(screen.getByText("chat.agentFailed")).toBeInTheDocument();
    expect(
      screen.queryByText("modelConfig.promptTitle"),
    ).not.toBeInTheDocument();
  });

  it("keeps a disconnected bridge ahead of the model error", () => {
    renderScreen(
      agentWith({
        last_error: "octop:agent_errors.no_models_configured",
        bridge: true,
        bridge_disconnected: true,
      }),
    );

    expect(
      screen.getByText("chat.remoteExpert.disconnectedTitle"),
    ).toBeInTheDocument();
  });
});

/**
 * The desktop shell has no console to send the user to: every create entry is
 * hidden there and the assistant is provisioned at sign-in. The recovery
 * actions must point at something the shell actually offers.
 */
describe("AgentNotReadyScreen in the desktop shell", () => {
  it("does not offer the create-expert path when there is no assistant", () => {
    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <AgentNotReadyScreen agent={null} noAgents desktopShell />
      </MemoryRouter>,
    );

    expect(screen.getByText("chat.desktopNoAgentsTitle")).toBeInTheDocument();
    expect(screen.queryByText("chat.noAgentsTitle")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "chat.createExpert" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "chat.desktopRetry" }),
    ).toBeInTheDocument();
  });

  it("sends a stopped assistant to model settings instead of the expert list", () => {
    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <AgentNotReadyScreen
          agent={agentWith({ state: "stopped" })}
          desktopShell
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("chat.agentNotRunning")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "modelConfig.configureButton" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "chat.goToExperts" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the browser recovery path", () => {
    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <AgentNotReadyScreen agent={agentWith({ state: "stopped" })} />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("button", { name: "chat.goToExperts" }),
    ).toBeInTheDocument();
  });
});
